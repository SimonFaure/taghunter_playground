import {
    askQuestion,
    BYTES,
    calcCRC,
    CRCtoBuffer,
    InitWorkingEnv,
    retrieveUSBPorts,
    SerialBuffer, SerialFlush, SerialRead, SerialWrite,
    setCRC,
    sleep, WorkingEnv
} from "./lib.js";
import pc from 'picocolors';
import {SerialPort} from "serialport";

console.log(pc.dim("Scanning available ports..."));

await retrieveUSBPorts();

let choice= null;
do {
    // Affichage des ports disponibles
    WorkingEnv.printPorts();
    choice = await askQuestion(pc.dim("Please specify your working port : "));
} while (!WorkingEnv.selectPort(choice))
console.log(pc.dim("Starting working with ")+pc.magenta(pc.bold(WorkingEnv.path)));
WorkingEnv.print();
// Mise à jour de l'env de travail avec le port recueilli
InitWorkingEnv(WorkingEnv.ports[parseInt(choice)-1]?.path);

await sleep(100);

let buf = Buffer.from(
    [ BYTES.STX, 0, 0, 0, 0, 0, 0, 0, BYTES.ETX ]
);
while (true){
    const received = await SerialRead(9);
    await SerialWrite(buf, true);
    await SerialRead(8);
    await SerialWrite(createValidStationFrame({ id: 1, cmd:0x1 }));
    await SerialWrite(createValidStationFrame({ id: 2, pr:0x1 }));
    await SerialWrite(createValidStationFrame({ id: 3, pr:0x3 }));
    await SerialWrite(createValidStationFrame({ id: 4, pr:0x5 }));
    await SerialWrite(createValidStationFrame({ id: 5, pr:0x7 }));
    await SerialWrite(createValidStationFrame({ id: 7 }), true);
    await SerialFlush();
    await sleep(700);
}

function createValidStationFrame({id = 0x01, cmd = 0x02, mode = 0x2, pr = 0x05}) {
    const buf = Buffer.alloc(134, 0);

    buf[0] = BYTES.STX;
    buf[1] = cmd;
    buf[2] = 0x80; // len
    buf[3] = id; // LSB station ID
    buf[4] = 0x00; // MSB station ID (1)

    // DONGLE
    // buf[0x11] = 0x6F; // Manufacturer
    // buf[0x12] = 0x21; // Manufacturer
    // buf[58] = 1;
    // buf[68] = 1;
    // buf[69] = pr;


    buf[0x77] = mode;
    buf[0x7A] = pr;


    // CRC over buf[1] to buf[132]
    setCRC(buf, 1);

    buf[133] = BYTES.ETX;

    return buf;
}

