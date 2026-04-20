import {
    askQuestion, checkCRC, GetSI9DataExt, InitWorkingEnv, ReadOneStationFrame,
    retrieveUSBPorts, SendReadRequest, SendWakeup, SerialPeek, SerialRead, sleep, WorkingEnv,
} from "./lib.js";
import pc from 'picocolors';

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
setInterval(()=>{
    //console.log(WorkingEnv.rx.buffer);
}, 1000);

while (true){
    const stations = [];
    console.log(pc.dim("Sending wakeup message..."));
    await SendWakeup()
    console.log(pc.green("Message sent"));
    await sleep(700);
    console.log(pc.dim("Waiting for peripheral response..."));
    await SerialRead(9);
    console.log(pc.green("Connection established"));
    console.log(pc.dim("Retrieving infos from peripheral..."));
    await SendReadRequest();
    await sleep(100);

    let k=7;
    while (k){
        k=7; //Nombre de tentatives maximales de lecture
        let buff = Buffer.alloc(0);
        while (k && (buff = await SerialPeek(3)) && (await SerialPeek(buff[2]+6)).length !== buff[2]+6){
            // Pause pendant un temps
            await sleep(100);
            k--;
        }
        let resp = null;
        if(k){
            console.log(pc.dim("Processing..."));
            resp = await ReadOneStationFrame();
            if(resp) stations.push(resp);
        }else {
            console.log(pc.blue("Finished"));
        }
    }
    console.log(pc.bold("Peripheral data : "));
    // Affichage des informations recueillies
    console.table(stations.map(s => (s.toJSON())));

    while(true){
        let buff = await SerialPeek(12);
        if(buff.length === 12 ) {
            buff = await SerialRead(12);
            if(buff[1]===0xE8 && checkCRC(buff, 1)){
                console.log(pc.green("Card detected... "), buff.toString('hex'));
                // TODO Send read data here
                await GetSI9DataExt();
                do{ buff = await SerialRead(12); }while (!checkCRC(buff, 1));
                console.log(pc.red("Card removed..."), buff.toString('hex'));
            }

        }
        await sleep(500);
    }
    await sleep(5000);
    break;
}




