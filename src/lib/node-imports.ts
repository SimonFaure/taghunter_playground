export const isElectron = () => {
  return typeof window !== 'undefined' &&
         typeof window.process !== 'undefined' &&
         window.process.type === 'renderer';
};

export const getSerialPort = async () => {
  if (!isElectron()) {
    throw new Error('SerialPort is only available in Electron');
  }
  const module = await import('serialport');
  return module.SerialPort;
};

export const getPicocolors = async () => {
  if (!isElectron()) {
    return {
      red: (text: string) => text,
      blue: (text: string) => text,
      cyan: (text: string) => text,
      magenta: (text: string) => text,
      dim: (text: string) => text,
      bold: (text: string) => text,
    };
  }
  return await import('picocolors');
};

export const getReadline = async () => {
  if (!isElectron()) {
    throw new Error('readline is only available in Electron');
  }
  return await import('node:readline');
};

export const nodeRequire = (moduleName: string) => {
  if (typeof window !== 'undefined' && (window as any).require) {
    return (window as any).require(moduleName);
  }
  throw new Error(`Node require is only available in Electron environment`);
};
