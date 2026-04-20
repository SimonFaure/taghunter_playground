const identity = (str) => str;

const picocolorsMock = {
  red: identity,
  green: identity,
  blue: identity,
  cyan: identity,
  magenta: identity,
  yellow: identity,
  dim: identity,
  bold: identity,
  gray: identity,
};

export default picocolorsMock;

export const SerialPort = class {
  constructor(options) {
    this.path = options?.path;
    this.baudRate = options?.baudRate || 38400;
    this.isOpen = false;
    this._callbacks = {};

    if (options?.autoOpen !== false) {
      this._autoOpen();
    }
  }

  async _autoOpen() {
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron && this.path) {
      try {
        const result = await window.electron.serialport.open(this.path, this.baudRate);
        if (result.success) {
          this.isOpen = true;
          if (this._callbacks.open) {
            this._callbacks.open();
          }
        } else if (this._callbacks.error) {
          this._callbacks.error(new Error(result.error || 'Failed to open port'));
        }
      } catch (error) {
        if (this._callbacks.error) {
          this._callbacks.error(error);
        }
      }
    }
  }

  on(event, callback) {
    this._callbacks[event] = callback;
    return this;
  }

  async write(data, callback) {
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron) {
      try {
        const buffer = Buffer.from(data);
        const result = await window.electron.serialport.write(Array.from(buffer));
        if (callback) {
          callback(result.success ? null : new Error(result.error));
        }
      } catch (error) {
        if (callback) {
          callback(error);
        }
      }
    } else {
      if (callback) callback();
    }
    return this;
  }

  async close(callback) {
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron) {
      try {
        await window.electron.serialport.close();
        this.isOpen = false;
        if (this._callbacks.close) {
          this._callbacks.close();
        }
      } catch (error) {
        console.error('Error closing port:', error);
      }
    }
    this.isOpen = false;
    if (callback) callback();
    return this;
  }

  async open(callback) {
    await this._autoOpen();
    if (callback) callback();
    return this;
  }

  static async list() {
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron) {
      return await window.electron.serialport.list();
    }
    return [];
  }
};
