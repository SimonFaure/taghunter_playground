import {SerialPort} from "serialport";
import pc from 'picocolors';
import readline from "node:readline";

export class WorkingEnv {
    static selectPort(index){
        if(WorkingEnv.ports.length < index || index < 1){
            console.error(pc.red("Invalid port index!"));
            return null
        }
        return WorkingEnv.path = WorkingEnv.ports[index-1].path;
    }
    static printPorts(){
        for (let i=0; i < WorkingEnv.ports.length; i++) {
            console.log(pc.dim("--> ")+ pc.cyan(i+1)+" "+WorkingEnv.ports[i].path);
        }
    }
    static print(){
        WorkingEnv.ports.map(port => {
            if(port.path===WorkingEnv.path){
                console.log(pc.dim('Port :              ')+ pc.magenta(pc.bold(`${port.path}`)));
                console.log(pc.dim(`Manufacturer:       `)+pc.blue(`${port.manufacturer}`));
                console.log(pc.dim(`Serial Number:      `)+pc.blue(`${port.serialNumber}`));
                console.log(pc.dim(`Vendor ID:          `)+pc.blue(`${port.vendorId}`));
                console.log(pc.dim(`Product ID:         `)+pc.blue(`${port.productId}\n`));
            }
        });
    }
}
/**
 * Pose une question à l'utilisateur via la console et retourne la réponse.
 *
 * - Utilise l'interface readline de Node.js pour afficher la question.
 * - Attend la saisie de l'utilisateur.
 * - Résout la promesse avec la réponse entrée.
 *
 * @param {string} question - Texte de la question à afficher.
 * @returns {Promise<string>} Réponse saisie par l'utilisateur.
 */
export function askQuestion(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question, (answer) => {
            resolve(answer);
            rl.close();
        });
    });
}

/**
 * Recherche et récupère la liste des ports USB disponibles.
 *
 * - Met à jour `WorkingEnv.ports` avec la liste des ports détectés via `SerialPort.list()`.
 * - Affiche la liste détaillée des ports si `print` est à `true`.
 * - En cas d’erreur, affiche un message d’erreur dans la console.
 *
 * @param {boolean} [print=false] - Indique si la liste des ports doit être affichée dans la console.
 * @returns {Promise<void>}
 */
export async function retrieveUSBPorts(print=false) {
    try {
        WorkingEnv.ports = await SerialPort.list();

        if (WorkingEnv.ports.length === 0) {
            print && console.log('Aucun port USB trouvé.');
        } else if(print) {
            console.log(pc.green(pc.bold(WorkingEnv.ports.length))+' Ports USB détectés :');
            WorkingEnv.ports.forEach(port => {
                console.log('- '+ pc.blue(`${port.path}`));
                console.log(`  Manufacturer: ${port.manufacturer}`);
                console.log(`  Serial Number: ${port.serialNumber}`);
                console.log(`  Vendor ID: ${port.vendorId}`);
                console.log(`  Product ID: ${port.productId}\n`);
            });
        }
    } catch (err) {
        console.error('Erreur lors de la détection des ports :', err);
    }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Initialise l’environnement de communication série pour la passerelle.
 *
 * - Configure le port série spécifié en lecture/écriture.
 * - Si `path` est fourni, il devient le nouveau port utilisé.
 * - Si `path` est `null`, réutilise le port déjà défini dans `WorkingEnv.path`.
 *
 * ️Cette fonction prépare les buffers de réception (`rx`) et d’émission (`tx`),
 *     ainsi que l’objet `SerialPort` utilisé pour la communication.
 *
 * @param {string|null} path - Chemin du port série à utiliser (ex: `/dev/ttyUSB0` ou `COM3`).
 *                             Si `null`, conserve le port déjà assigné à `WorkingEnv.path`.
 */
export function InitWorkingEnv(path=null){
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (!isElectron) {
        console.warn('InitWorkingEnv can only be called in Electron context');
        return;
    }

    WorkingEnv.rate = 38400;
    WorkingEnv.rx = new SerialBuffer();
    WorkingEnv.tx = new SerialBuffer();
    if(path) WorkingEnv.path = path;
    WorkingEnv.port = new SerialPort({
        path: WorkingEnv.path,
        baudRate: WorkingEnv.rate,
        dataBits: 8,            // 8 bits de données
        stopBits: 1,            // 1 bit de stop
        parity: 'none',         // pas de parité
        autoOpen: true,
    });
    WorkingEnv.port.on('open', () => { console.log(pc.green('Port ouvert avec succès')); });
    WorkingEnv.port.on('error', (err) => { console.error(pc.red('Erreur à l\'ouverture :'), err.message); });
    WorkingEnv.port.on('data', (chunk) => { WorkingEnv.rx.append(chunk); });
    WorkingEnv.port.on('close', () => {});
}


/**
 * Octets spéciaux du protocole de communication série.
 *
 * - `WAKEUP` : Octet utilisé pour réveiller les périphériques en veille (0xFF).
 * - `STX` : Start of Text – indique le début d’une trame (0x02).
 * - `ETX` : End of Text – indique la fin d’une trame (0x03).
 *
 * Ces constantes servent à délimiter les messages dans le protocole binaire.
 *
 * @type {{WAKEUP: number, STX: number, ETX: number}}
 */
export const BYTES = {
    WAKEUP: 0xFF,
    STX: 0x02,
    ETX: 0x03,
    ACK: 0x06,
    NAK: 0x15,
}

/**
 * Classe SerialBuffer
 *
 * Implémente un tampon FIFO (First-In-First-Out) pour la gestion des flux série.
 *
 * Fonctionnalités :
 * - Lecture bloquante asynchrone avec attente si nécessaire (`read`)
 * - Lecture non-destructive (`peek`)
 * - Ajout de données (`append`)
 * - Gestion manuelle des lectures en attente (`refresh`)
 * - Lecture du contenu brut, vidage et conversion (`buffer`, `clear`, `toString`)
 *
 * Cas d’usage : communication série ou réseau où les trames arrivent de façon fragmentée.
 */
export class SerialBuffer {
    constructor(initial = []) {
        this._buffer = Buffer.from(initial);
        this._waiters = [];
    }

    _fulfillWaiters() {
        while (this._waiters.length > 0) {
            const { n, resolve } = this._waiters[0];
            if (this._buffer.length >= n) {
                const out = this._buffer.subarray(0, n);
                this._buffer = this._buffer.subarray(n);
                this._waiters.shift();
                resolve(out);
            } else {
                break;
            }
        }
    }

    /**
     * Retourne le buffer natif encapsulé
     * @returns {Buffer<ArrayBuffer>}
     */
    get buffer() {
        return this._buffer;
    }

    get length() {
        return this._buffer.length;
    }

    isEmpty() {
        return this._buffer.length === 0;
    }

    /**
     * Ajoute des données à la fin du tampon de réception.
     *
     * - Convertit les données entrantes en `Buffer` (si ce n'est pas déjà un buffer).
     * - Étend `_buffer` en concaténant les nouvelles données.
     * - Déclenche immédiatement une tentative de satisfaction des lectures bloquantes (`_fulfillWaiters()`).
     *
     * @param {Buffer | ArrayBuffer | Uint8Array | string} data - Données à ajouter au tampon.
     */
    append(data) {
        const incoming = Buffer.from(data);
        this._buffer = Buffer.concat([this._buffer, incoming]);
        this._fulfillWaiters();
    }

    /**
     * Déclenche manuellement une vérification des lectures bloquantes en attente.
     * - Utilisée lorsqu’un changement externe est apporté au tampon (`_buffer`)
     *   sans passer par les méthodes prévues (`append`, etc.).
     * - Appelle `_fulfillWaiters()` pour tenter de satisfaire toute promesse en attente via `read(n)`.
     * - Utile dans les cas où le tampon est modifié de manière directe ou non conventionnelle.
     * À utiliser uniquement si on modifie `_buffer` directement ou injectes des données via un canal non standard.
     */
    refresh(){
        this._fulfillWaiters();
    }

    /**
     * Lecture bloquante de `n` octets depuis le tampon RX.
     *
     * - Fonctionne en mode FIFO (first-in, first-out).
     * - Si suffisamment de données sont déjà présentes, retourne immédiatement un `Buffer`.
     * - Sinon, attend de manière asynchrone jusqu’à ce que `n` octets soient disponibles.
     * - ATTENTION : Les octets lus sont retirés définitivement du tampon (destructif).
     *
     * @param {number} n - Nombre d’octets à lire.
     * @returns {Promise<Buffer>} - Un `Buffer` contenant exactement `n` octets.
     */
    async read(n) {

        if (this._buffer.length >= n) {
            const out = this._buffer.subarray(0, n);
            this._buffer = this._buffer.subarray(n);
            return out;
        }

        return new Promise((resolve) => {
            this._waiters.push({ n, resolve });
        });
    }

    /**
     * Prévisualise jusqu’à `n` octets en tête du tampon sans les consommer.
     *
     * - Retourne une vue (`Buffer.subarray`) des `n` premiers octets.
     * - Ne modifie pas le contenu du tampon.
     * - Si le tampon contient moins de `n` octets, retourne tous les octets disponibles.
     * - Utile pour vérifier si une trame complète est présente sans la retirer.
     *
     * @param {number} n - Nombre maximal d’octets à lire.
     * @returns {Buffer} - Un buffer contenant au plus `n` octets du début du tampon.
     */
    peek(n) {
        return this._buffer.subarray(0, n);
    }

    clear() {
        this._buffer = Buffer.alloc(0);
    }

    toString(encoding = 'hex') {
        return this._buffer.toString(encoding);
    }
}

/**
 * Classe modélisant une station SportIdent.
 *
 * Cette classe permet de parser et représenter les données
 * reçues d’une station ou dongle SportIdent, en exposant
 * les propriétés principales comme le numéro de station,
 * le mode, les flags de communication et le canal radio.
 */
export class Station {
    static MO_IDX = 0x77;
    constructor() {
        this.stationNumber = null;
        this.stationMode = 0;
        this.extended = false;
        this.handShake = false;
        this.autoSend = false;
        this.radioChannel = 0;
    }

    /**
     * Analyse et interprète les données reçues dans le buffer pour extraire les informations de la station.
     * eq. readSystemData
     *
     * - Détecte si le buffer correspond à un dongle (en vérifiant des octets spécifiques).
     * - Si c’est un dongle, délègue à `dongle_parse`.
     * - Sinon, extrait les différents paramètres à partir des positions fixées dans le buffer :
     *   - `stationNumber` (combinaison des octets 3 et 4),
     *   - `radioChannel` (ici fixé à false par défaut),
     *   - Flags `extended`, `autoSend`, `handShake` issus de l’octet `pr` (offset 0x0A),
     *   - `stationMode` à partir de l’octet `mo` (offset défini par 0x07).
     *
     * @param {Buffer} buffer - Trame de données brute reçue.
     * @returns {Station} L’objet `Station` mis à jour avec les données extraites.
     */
    parse(buffer){

        const pr = buffer[0x0A];
        const mo = buffer[0x07];


        this.stationNumber = 0x1FF & (buffer[3]+buffer[4]*256);
        this.radioChannel = false;
        this.extended = Boolean(pr & 0x01);
        this.autoSend = Boolean(pr & 0x02);
        this.handShake = Boolean(pr & 0x04);
        this.stationMode = mo & 0x0F;

        return this;
    }

    /**
     * Analyse et interprète les données reçues dans le buffer pour extraire les informations de la station.
     * eq. readSystemDatav2
     *
     * - Détecte si le buffer correspond à un dongle (en vérifiant des octets spécifiques).
     * - Si c’est un dongle, délègue à `dongle_parse`.
     * - Sinon, extrait les différents paramètres à partir des positions fixées dans le buffer :
     *   - `stationNumber` (combinaison des octets 3 et 4),
     *   - `radioChannel` (ici fixé à false par défaut),
     *   - Flags `extended`, `autoSend`, `handShake` issus de l’octet `pr` (offset 0x7A),
     *   - `stationMode` à partir de l’octet `mo` (offset défini par `MO_IDX`).
     *
     * @param {Buffer} buffer - Trame de données brute reçue.
     * @returns {Station} L’objet `Station` mis à jour avec les données extraites.
     */
    parse_v2(buffer){
        const is_dongle = buffer[0x11] === 0x6F && buffer[0x12] === 0x21;
        if(is_dongle) { return this.dongle_parse(buffer); }

        const pr = buffer[0x7A];
        const mo = buffer[Station.MO_IDX];


        this.stationNumber = 0x1FF & (buffer[3]+buffer[4]*256);
        this.radioChannel = false;
        this.extended = Boolean(pr & 0x01);
        this.autoSend = Boolean(pr & 0x02);
        this.handShake = Boolean(pr & 0x04);
        this.stationMode = mo & 0x0F;

        return this;
    }

    /**
     * Analyse les données spécifiques d’un dongle contenues dans le buffer.
     *
     * - Extrait les informations propres au dongle à partir des octets dédiés.
     * - Initialise `stationNumber` à 0 car non pertinent pour un dongle.
     * - Lit le canal radio à partir de l’octet 58.
     * - Détermine les flags `extended` et `autoSend` à partir des octets 69 et 68.
     * - `handShake` est forcé à `false` car non utilisé ici.
     * - Extrait le mode de station à partir de l’octet `mo`.
     *
     * @param {Buffer} buffer - Trame de données brute reçue correspondant à un dongle.
     * @returns {Station} L’objet `Station` mis à jour avec les données extraites.
     */
    dongle_parse(buffer) {
        const pr = buffer[69];
        const mo = buffer[Station.MO_IDX];

        this.stationNumber = 0;
        this.radioChannel = buffer[58] & 0x1;
        this.extended = Boolean(pr & 0x01);
        this.autoSend = buffer[68] === 0x01;
        this.handShake = false;
        this.stationMode = mo & 0x0F;

        return this;
    }
    toString() {
        return `Station[#${this.stationNumber}] mode=${this.stationMode}, ext=${this.extended}, hs=${this.handShake}, auto=${this.autoSend}, ch=${this.radioChannel}`;
    }
    toJSON() {
        return {
            stationNumber: this.stationNumber,
            stationMode: this.stationMode,
            extended: this.extended,
            handShake: this.handShake,
            autoSend: this.autoSend,
            radioChannel: this.radioChannel
        };
    }
    toColorString() {
        return [
            pc.dim('Station') + pc.cyan(`#${this.stationNumber}`),
            pc.dim('\tmode=') + pc.green(this.stationMode),
            pc.dim('\text=') + (this.extended ? pc.blue('on ') : pc.gray('off')),
            pc.dim('hs=') + (this.handShake ? pc.blue('on ') : pc.gray('off')),
            pc.dim('auto=') + (this.autoSend ? pc.blue('on ') : pc.gray('off')),
            pc.dim('ch=') + pc.yellow(this.radioChannel)
        ].join(' ');
    }
}


/**
 * Lit de manière bloquante `n` octets depuis le buffer de réception série.
 *
 * - Si suffisamment de données sont déjà présentes, retourne immédiatement un `Buffer`.
 * - Sinon, attend de façon asynchrone que `n` octets soient disponibles.
 * - Les octets lus sont retirés du buffer (consommation destructive).
 *
 * @param {number} n - Nombre d’octets à lire.
 * @returns {Promise<Buffer>} Un buffer contenant exactement `n` octets.
 */
export async function SerialRead(n){
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron) {
        let attempts = 0;
        const maxAttempts = 100;
        while (attempts < maxAttempts) {
            const result = await window.electron.serialport.peek(n);
            if (result.success && result.length >= n) {
                const readResult = await window.electron.serialport.read(n);
                return Buffer.from(readResult.data);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
            attempts++;
        }
        return Buffer.alloc(0);
    }
    return WorkingEnv.rx.read(n);
}


/**
 * Regarde (sans consommer) les `n` prochains octets du tampon de réception série.
 *
 * @param {number} n - Nombre d'octets à prévisualiser.
 * @returns {Promise<Buffer>} - Un buffer contenant jusqu'à `n` octets, s'ils sont disponibles.
 */
export async function SerialPeek(n){
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    if (isElectron) {
        const result = await window.electron.serialport.peek(n);
        return result.success ? Buffer.from(result.data) : Buffer.alloc(0);
    }
    return WorkingEnv.rx.peek(n);
}


/**
 * Enfile un buffer pour l’écriture série.
 *
 * @param {Buffer} buffer - Les données à envoyer via le port série.
 * @param {boolean} [flush=false] - Si true, vide immédiatement la file d’attente via SerialFlush().
 *
 * @returns {Promise<boolean>} - Résout à `true` si le buffer est ajouté sans erreur,
 *                              ou le résultat de `SerialFlush()` si `flush` est vrai.
 */
export async function SerialWrite(buffer, flush=false) {
    WorkingEnv.tx.append(buffer);
    return !flush || (await SerialFlush());
}

/**
 * Envoie immédiatement toutes les données en attente sur le port série.
 *
 * Cette fonction lit et vide la file tampon `WorkingEnv.tx`,
 * puis écrit les données sur le port série si celui-ci est ouvert.
 *
 * @returns {boolean} - `true` si les données ont été envoyées ou s’il n’y avait rien à envoyer.
 *                      `false` si aucun port n’est ouvert.
 */
export async function SerialFlush() {
    const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;

    if (isElectron) {
        const status = await window.electron.serialport.isOpen();
        if (status.isOpen) {
            if(!WorkingEnv.tx.length) return true;
            console.log(pc.dim("Pushing on port: "), WorkingEnv.tx.toString('hex'));
            const data = await WorkingEnv.tx.read(WorkingEnv.tx.length);
            await window.electron.serialport.write(Array.from(data));
            return true;
        }
        console.warn(pc.dim("No port opened"));
        return false;
    }

    if(WorkingEnv?.port?.isOpen){
        if(!WorkingEnv.tx.length) return true;
        console.log(pc.dim("Pushing on port: "), WorkingEnv.tx.toString('hex'));
        WorkingEnv.port.write(await WorkingEnv.tx.read(WorkingEnv.tx.length));
        return true;
    }
    console.warn(pc.dim("No port opened"));
    return false;
}

/**
 * Calcule le CRC (Cyclic Redundancy Check) pour un tableau d’octets donné.
 *
 * - Utilisé pour vérifier l’intégrité des données transmises.
 * - Applique l’algorithme CRC spécifique au protocole utilisé.
 *
 * @param {Buffer | Uint8Array} data - Données sur lesquelles calculer le CRC.
 * @returns {number} Valeur CRC calculée (généralement sur 16 bits).
 */
export function calcCRC(data) {
    if (data.length < 2) return 0;
    let index = 0;
    let crc = (data[index] << 8) + data[index + 1];
    index += 2;

    if (data.length === 2) return crc;

    let value;

    for (let k = Math.floor(data.length / 2); k > 0; k--) {
        if (k > 1) {
            value = (data[index] << 8) + data[index + 1];
            index += 2;
        } else {
            value = (data.length & 1) ? (data[index] << 8) : 0;
        }

        for (let j = 0; j < 16; j++) {
            const bitCRC = (crc & 0x8000) !== 0;
            const bitVal = (value & 0x8000) !== 0;
            crc <<= 1;
            if (bitVal) crc++;
            if (bitCRC) crc ^= 0x8005;
            crc &= 0xFFFF;
            value <<= 1;
        }
    }
    return crc;
}

/**
 * Convertit une valeur CRC 16 bits en un buffer de 2 octets.
 *
 * - Le premier octet contient les 8 bits de poids fort.
 * - Le second octet contient les 8 bits de poids faible.
 *
 * @param {number} crc - Valeur CRC 16 bits.
 * @returns {Buffer} Buffer de 2 octets représentant le CRC.
 */
export function CRCtoBuffer(crc) {
    return Buffer.from([crc >> 8, crc & 0xFF]);
}

/**
 * Calcule et insère le CRC dans un buffer donné à une position spécifique.
 *
 * - Lit la longueur du bloc à partir de `buff[start + 1]`.
 * - Calcule le CRC sur la tranche de données `buff[start]` jusqu'à `start + len + 1`.
 * - Convertit le CRC en buffer 2 octets.
 * - Insère les octets CRC juste après la tranche de données (aux positions `start + len + 2` et `start + len + 3`).
 *
 * @param {Buffer} buff - Buffer contenant les données et où insérer le CRC.
 * @param {number} start - Position de départ dans le buffer pour le calcul.
 */
export function setCRC(buff, start){
    const len = buff[start+1];
    const crc = CRCtoBuffer(calcCRC((buff.subarray(start, start+len+2))));
    buff[start + len + 2] = crc[0];
    buff[start + len + 3] = crc[1];
}

/**
 * Vérifie l'intégrité d'un buffer en comparant son CRC calculé avec celui stocké.
 *
 * - Lit la longueur du bloc à partir de `buff[start + 1]`.
 * - Calcule le CRC sur la tranche de données `buff[start]` jusqu'à `start + len + 1`.
 * - Compare le CRC calculé aux deux octets CRC présents dans le buffer.
 *
 * @param {Buffer} buff - Buffer contenant les données et le CRC.
 * @param {number} start - Position de départ dans le buffer pour le calcul.
 * @returns {boolean} `true` si le CRC est valide, `false` sinon.
 */
export function checkCRC(buff, start){
    const len = buff[start+1];
    const crc = CRCtoBuffer(calcCRC((buff.subarray(start, start+len+2))));
    return buff[start + len + 2] === crc[0] && buff[start + len + 3] === crc[1];
}


/**
 * Envoie un message de réveil (wakeup) à la station via la liaison série.
 *
 * - Construit un buffer spécifique contenant les octets de wakeup et de contrôle.
 * - Calcule et insère le CRC dans le buffer à la position adéquate.
 * - Écrit le buffer sur le port série en forçant le flush.
 *
 * @returns {Promise<void>} Résolution lorsque l’écriture est terminée.
 */
export async function SendWakeup(){
    // Construction de la trame
    let buf = Buffer.from(
        [
            BYTES.WAKEUP,   // Octet de réveil
            BYTES.STX,
            BYTES.STX,
            0xF0,
            0x01,           // Taille utile de la trame
            0x4D,
            0x00,           // MSB du CRC (sera calculé plus tard
            0x00,           // LSB du CRC
            BYTES.ETX       // Fin de message
        ]
    );
    // Calcule et insertion du CRC
    setCRC(buf, 3);

    // Envoi immédiat de la trame sur le bus
    await SerialWrite(buf, true);
}

/**
 * Envoie une requête de lecture à la station via la liaison série.
 *
 * - Construit un buffer spécifique contenant la commande de lecture.
 * - Calcule et insère le CRC dans le buffer à la position adéquate.
 * - Écrit le buffer sur le port série en forçant le flush.
 *
 * @returns {Promise<void>} Résolution lorsque l’écriture est terminée.
 */
export async function SendReadRequest(){
    // Construction de la trame de demande de lecture
    let buf = Buffer.from(
        [
            BYTES.STX,
            0x83,
            0x02,
            0x00,
            0x80,
            0x00,
            0x00,
            BYTES.ETX
        ]
    );
    // Calcul et insertion du CRC
    setCRC(buf, 1);

    // Envoi immédiat de la trame sur le bus
    await SerialWrite(buf, true);
}

/**
 * Lit une trame complète de station depuis la liaison série.
 *
 * - Lit 0x86 octets en attente dans le buffer série.
 * - Vérifie l’intégrité de la trame via le CRC.
 * - Si valide, crée une instance de `Station` et la remplit avec les données parsées.
 * - Retourne l’objet `Station` si succès, sinon `false`.
 *
 * @returns {Promise<Station|false>} Une instance `Station` ou `false` si CRC invalide.
 */
export async function ReadOneStationFrame(){
    // On recueille d'abord les 3 trois premiers octets pour avoir la taille utile
    let buf = await SerialPeek(3);

    // La trame est composée par la suite STX - (1 octet) - TAILLE
    const len = buf[2];

    // On récupère `len` + 6 octets supplémentaires (STX, ETX,...) de protocole
    buf = await SerialRead(len+6);
    // Vérification du CRC
    if(checkCRC(buf, 1)){
        const si = new Station();
        // On choisit la version de parsing en fonction de la taille utile
        // 0x80 pour la v2 sinon, on utilise le parsing basique
        len === 0x80 ? si.parse_v2(buf) : si.parse(buf);
        // Rajouter des traitements supplémentaires ici
        return si;
    }
    return false;
}
export async function GetSI9DataChunk(chunk=0){

    // Construction de la trame de demande de lecture
    let buf = Buffer.from(
        [
            BYTES.STX,
            0xEF,
            0x01,
            chunk,
            0x00,
            0x00,
            BYTES.ETX
        ]
    );
    // Calcul et insertion du CRC
    setCRC(buf, 1);

    // Envoi immédiat de la trame sur le bus
    await SerialWrite(buf, true);

    // On récupère `len` + 8 octets supplémentaires (STX, ETX,...) de protocole
    buf = await SerialRead(128+9);
    // Vérification du CRC
    if(checkCRC(buf, 1) && buf[1]===0xEF && buf[0]===BYTES.STX){
        buf = await (new SerialBuffer(buf.subarray(6))).read(128);
        return buf;
    }
    return false;
}
export async function GetSI9DataExt(limit=2){
    let chunk = 0;
    let buf = await GetSI9DataChunk();
    if(!buf) return;
    limit--;chunk++;
    const card = new SICard();
    while (limit--){
        const next = await GetSI9DataChunk(chunk++);
        if(next) buf =Buffer.concat([buf, next]);
    }
    await SerialWrite(Buffer.from([BYTES.ACK]));
    await card.parse(buf);
    await card.readBattery();
    console.log("card : ", card.toJSON());
}

export const TIMECONSTANTS = {
    HOUR: 36000,
    SECOND: 10
}

export class Punch{
    time = 0;
    code = 0;
    toJSON(){
        return {
            code: this.code,
            time: this.getLitteralTime()
        }
    }

    getLitteralTime() {
        let time = this.time;
        const h = Math.floor(time / TIMECONSTANTS.HOUR).toFixed(0).padStart(2, '0');
        time -= TIMECONSTANTS.HOUR * h;
        const m = Math.floor(time / (60 * TIMECONSTANTS.SECOND)).toFixed(0).padStart(2, '0');
        time -= 60 * TIMECONSTANTS.SECOND * m;
        const s = (time/TIMECONSTANTS.SECOND).toFixed(0).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    analyseHour12Time(zeroTime) {
        if (this.code !== -1 && this.time >= 0 && this.time <= 12 * TIMECONSTANTS.HOUR) {
            if (zeroTime < 12 * TIMECONSTANTS.HOUR) {
                // Matinée
                if (this.time < zeroTime) {
                    this.time += 12 * TIMECONSTANTS.HOUR; // Corrige vers après-midi
                }
            } else {
                // Après-midi
                if (this.time >= zeroTime % (12 * TIMECONSTANTS.HOUR)) {
                    this.time += 12 * TIMECONSTANTS.HOUR;
                }
                // Sinon, c'est après minuit, OK
            }
        }
    }
}

export class SICard{
    startPunch = undefined;
    endPunch = undefined;
    checkPunch = undefined;
    punches=[];
    nbPunch=0;
    constructor(){}
    async parse(buf){
        this.series = buf[24] & 0xF;
        this.id = buf[27] + buf[26]*256 + buf[25]*256*256;
        this.startPunch = await this.analyzePunch(buf.subarray(12), true)
        this.endPunch = await this.analyzePunch(buf.subarray(16), true)
        this.checkPunch = await this.analyzePunch(buf.subarray(8))
        this.nbPunch = 0;
        if(this.series===1){
            this.nbPunch = buf[22];
            if(this.nbPunch > 50) this.nbPunch = 50;
            await this.getPunches(buf);
        }
        this.buffer = buf;
    }

    async getPunches(buf=null) {
        if(!buf) buf = this.buffer;
        for (let i = 0; i < this.nbPunch; i++) {
            const punch = await this.analyzePunch(buf.subarray(14*4+i*4));
            if(!punch) continue;
            this.punches.push(punch);
        }
    }

    async analyzePunch(buf, subsecond=false){
        if((buf[0]===0xEE && buf[1]===0xEE && buf[2]===0xEE && buf[3]===0xEE)
        || (buf[0]===0x00 && buf[1]===0x00 && buf[2]===0x00 && buf[3]===0x00)){
            return undefined;
        }

        const ptd = buf[0];
        let cn = buf[1]??0;
        const pth = buf[2];
        const ptl = buf[3];

        const pt = pth*256+ptl;


        let time = pt * TIMECONSTANTS.SECOND + TIMECONSTANTS.HOUR*12*(ptd & 0x1);
        let control = 0;
        if(!subsecond){
            if ((ptd >> 7) & 1) { //Beacon Start or Finish punch: Code stored in Block 1
                cn = buf[153];
            }
            if(cn && ptd) control = cn + 256 * ((ptd >> 6) & 0x1);
        }else {
            const tss = buf[1]; // Sub second 1/256 seconds
            const tenth = (((100 * tss) / 256) + 4) / 10;
            time += tenth;
        }
        const res = new Punch();
        res.time = time;
        res.code = control;
        return res;
    }

    async readBattery() {
        // TODO Implement voltage reading here
    }

    toJSON(){
        return {
            id : this.id,
            series :  this.series,
            start : this.startPunch?.toJSON(),
            end : this.endPunch?.toJSON(),
            check: this.checkPunch?.toJSON(),
            nbPunch: this.nbPunch,
            punches : this.punches.map(p => {return p?.toJSON();}),
        }
    }
}