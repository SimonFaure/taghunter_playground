/// <reference types="vite/client" />

interface Window {
  electron?: {
    getComputerName: () => Promise<string>;
    checkWifi: () => Promise<{ isConnected: boolean; networkName: string | null }>;
    isElectron: boolean;
    serialport: {
      list: () => Promise<any[]>;
      open: (portPath: string, baudRate: number) => Promise<{ success: boolean; error?: string }>;
      write: (data: number[]) => Promise<{ success: boolean; error?: string }>;
      read: (length: number) => Promise<{ success: boolean; data: number[]; error?: string }>;
      peek: (length: number) => Promise<{ success: boolean; data: number[]; length: number; error?: string }>;
      isOpen: () => Promise<{ isOpen: boolean }>;
      close: () => Promise<{ success: boolean; error?: string }>;
    };
    config: {
      load: () => Promise<any>;
      save: (config: any) => Promise<{ success: boolean }>;
      getPath: () => Promise<string>;
    };
    games: {
      getFolderPath: () => Promise<string>;
      list: () => Promise<string[]>;
      readFile: (gameId: string, filename: string) => Promise<string>;
      writeFile: (gameId: string, filename: string, content: string, isBinary?: boolean) => Promise<{ success: boolean }>;
      getMediaPath: (gameId: string, filename: string) => Promise<string>;
      listMediaFolder: (gameId: string, folderId: string) => Promise<string[]>;
    };
    db: {
      connect: () => Promise<{ success: boolean; message?: string }>;
      testConnection: (url: string) => Promise<{ success: boolean; message: string }>;
      query: (sql: string, params?: any[]) => Promise<{ rows: any[] | null; error: string | null }>;
    };
    clients: {
      load: () => Promise<{ success: boolean; clients: any[] }>;
      saveSelected: (clientData: any) => Promise<{ success: boolean }>;
      loadSelected: () => Promise<{ success: boolean; client: any | null }>;
    };
    patterns: {
      listFolders: (gameTypeName: string) => Promise<string[]>;
      readFile: (gameTypeName: string, patternName: string, fileName: string) => Promise<string>;
    };
    scenarios: {
      getFolderPath: () => Promise<string>;
      load: () => Promise<any>;
      saveGameData: (uniqid: string, gameData: any) => Promise<{ success: boolean }>;
      saveMedia: (uniqid: string, folder: string, filename: string, base64Data: string) => Promise<{ success: boolean }>;
      refresh: () => Promise<any>;
    };
    apiLogs: {
      write: (logData: any) => Promise<{ success: boolean; error?: string }>;
      read: () => Promise<{ success: boolean; logs: any[]; error?: string }>;
      clear: () => Promise<{ success: boolean; error?: string }>;
    };
  };
}
