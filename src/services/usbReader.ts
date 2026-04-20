import { WorkingEnv, InitWorkingEnv, SendWakeup, SendReadRequest, SerialRead, SerialPeek, ReadOneStationFrame, checkCRC, GetSI9DataExt, sleep, retrieveUSBPorts } from '../lib/lib.js';

export interface USBPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface CardData {
  id: number;
  series: number;
  start?: {
    code: number;
    time: string;
  };
  end?: {
    code: number;
    time: string;
  };
  check?: {
    code: number;
    time: string;
  };
  nbPunch: number;
  punches: Array<{
    code: number;
    time: string;
  }>;
}

export interface StationData {
  stationNumber: number;
  stationMode: number;
  extended: boolean;
  handShake: boolean;
  autoSend: boolean;
  radioChannel: boolean | number;
}

const CARD_DEBOUNCE_MS = 5000;

export class USBReaderService {
  private isRunning = false;
  private isPortOpen = false;
  private currentPort: string | null = null;
  private onCardDetected?: (card: CardData) => void;
  private onCardRemoved?: () => void;
  private onStationsDetected?: (stations: StationData[]) => void;
  private lastCardTimestamps = new Map<number, number>();

  isElectron(): boolean {
    return typeof window !== 'undefined' && (window as any).electron?.isElectron === true;
  }

  async getAvailablePorts(): Promise<USBPort[]> {
    if (!this.isElectron()) {
      console.warn('USB functionality only available in Electron');
      return [];
    }
    try {
      const electron = (window as any).electron;
      if (electron?.serialport?.list) {
        const ports = await electron.serialport.list();
        return ports || [];
      }
      return [];
    } catch (error) {
      console.error('Error getting USB ports:', error);
      return [];
    }
  }

  async closePort(): Promise<void> {
    if (!this.isElectron() || !this.isPortOpen) {
      return;
    }
    try {
      console.log('🔌 Closing serial port...');
      const electron = (window as any).electron;
      if (electron?.serialport?.close) {
        await electron.serialport.close();
        this.isPortOpen = false;
        this.currentPort = null;
        console.log('✓ Port closed successfully');
      }
    } catch (error) {
      console.error('Error closing port:', error);
    }
  }

  async initializePort(portPath: string): Promise<boolean> {
    if (!this.isElectron()) {
      console.warn('USB functionality only available in Electron');
      return false;
    }

    if (this.isPortOpen && this.currentPort === portPath) {
      console.log('✓ Port already open on', portPath);
      return true;
    }

    if (this.isPortOpen) {
      console.log('⚠️  Port already open on different path, closing first...');
      await this.closePort();
      await sleep(500);
    }

    try {
      console.log('🔌 Opening port:', portPath);
      InitWorkingEnv(portPath);
      await sleep(100);
      this.isPortOpen = true;
      this.currentPort = portPath;
      return true;
    } catch (error) {
      console.error('Error initializing port:', error);
      this.isPortOpen = false;
      this.currentPort = null;
      return false;
    }
  }

  setCardDetectedCallback(callback: (card: CardData) => void) {
    this.onCardDetected = callback;
  }

  setCardRemovedCallback(callback: () => void) {
    this.onCardRemoved = callback;
  }

  setStationsDetectedCallback(callback: (stations: StationData[]) => void) {
    this.onStationsDetected = callback;
  }

  async start() {
    if (!this.isElectron()) {
      console.warn('USB functionality only available in Electron');
      return;
    }
    if (this.isRunning) {
      console.warn('USB Reader already running');
      return;
    }

    console.log('🎧 Starting USB listener - Entering read loop...');
    this.isRunning = true;
    await this.readLoop();
  }

  async stop() {
    console.log('🛑 Stopping USB listener - Exiting read loop...');
    this.isRunning = false;
    await sleep(500);
    await this.closePort();
  }

  private async readLoop() {
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;

    while (this.isRunning) {
      try {
        if (!this.isPortOpen) {
          console.warn('Port not open, stopping read loop');
          break;
        }

        const stations: StationData[] = [];

        console.log('Sending wakeup message...');
        await SendWakeup();
        await sleep(300);

        console.log('Waiting for peripheral response...');
        await SerialRead(9);
        console.log('Connection established');

        console.log('Retrieving infos from peripheral...');
        await SendReadRequest();
        await sleep(50);

        let k = 7;
        while (k) {
          k = 7;
          let buff = Buffer.alloc(0);

          while (k && (buff = await SerialPeek(3)) && (await SerialPeek(buff[2] + 6)).length !== buff[2] + 6) {
            await sleep(50);
            k--;
          }

          let resp = null;
          if (k) {
            console.log('Processing station data...');
            resp = await ReadOneStationFrame();
            if (resp) stations.push(resp.toJSON());
          } else {
            console.log('Finished reading stations');
          }
        }

        if (stations.length > 0 && this.onStationsDetected) {
          this.onStationsDetected(stations);
        }

        consecutiveErrors = 0;

        while (this.isRunning) {
          try {
            let buff = await SerialPeek(12);

            if (buff.length === 12) {
              buff = await SerialRead(12);

              if (buff[1] === 0xE8 && checkCRC(buff, 1)) {
                console.log('Card detected...', buff.toString('hex'));

                const cardData = await this.readCardData();

                if (cardData && this.onCardDetected) {
                  const now = Date.now();
                  const last = this.lastCardTimestamps.get(cardData.id) ?? 0;
                  if (now - last >= CARD_DEBOUNCE_MS) {
                    this.lastCardTimestamps.set(cardData.id, now);
                    this.onCardDetected(cardData);
                  } else {
                    console.log(`Card ${cardData.id} ignored (debounce: ${Math.round((now - last) / 1000)}s < ${CARD_DEBOUNCE_MS / 1000}s)`);
                  }
                }

                do {
                  buff = await SerialRead(12);
                } while (!checkCRC(buff, 1));

                console.log('Card removed...', buff.toString('hex'));

                if (this.onCardRemoved) {
                  this.onCardRemoved();
                }
              }
            }

            await sleep(200);
          } catch (innerError) {
            console.error('Error reading card data:', innerError);
            await sleep(500);
          }
        }

        await sleep(5000);
      } catch (error) {
        consecutiveErrors++;
        console.error(`Error in read loop (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error('Too many consecutive errors, stopping USB reader');
          this.isRunning = false;
          break;
        }

        await sleep(2000);
      }
    }

    console.log('Read loop exited');
  }

  private async readCardData(): Promise<CardData | null> {
    try {
      const cardDataPromise = new Promise<CardData | null>((resolve) => {
        const originalLog = console.log;
        let capturedCard: CardData | null = null;

        console.log = (...args: any[]) => {
          if (args[0] === 'card : ' && args[1]) {
            capturedCard = args[1] as CardData;
          }
          originalLog(...args);
        };

        GetSI9DataExt().then(() => {
          console.log = originalLog;
          resolve(capturedCard);
        }).catch((error) => {
          console.log = originalLog;
          console.error('Error reading card data:', error);
          resolve(null);
        });
      });

      return await cardDataPromise;
    } catch (error) {
      console.error('Error reading card data:', error);
      return null;
    }
  }
}

export const usbReaderService = new USBReaderService();
