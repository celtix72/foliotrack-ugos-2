'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation (standard IEEE 802.3)
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
}

function calculateCRC32(buffer) {
    if (typeof zlib.crc32 === 'function') {
        return zlib.crc32(buffer);
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dateToDosTime(date) {
    const d = date || new Date();
    const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    const dosDate = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { dosTime, dosDate };
}

/**
 * Creates a valid PKZIP (.zip) buffer containing the given files.
 * @param {Array<{ name: string, data: Buffer|string }>} files
 * @returns {Buffer}
 */
function createZipBuffer(files) {
    const localHeaders = [];
    const cdHeaders = [];
    let offset = 0;
    const now = new Date();
    const { dosTime, dosDate } = dateToDosTime(now);

    for (const file of files) {
        const nameBuffer = Buffer.from(file.name, 'utf8');
        const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
        const uncompressedSize = rawData.length;
        const crc = calculateCRC32(rawData);

        // Compress with DeflateRaw
        const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
        const compressedSize = compressedData.length;

        // Local Header
        const localHeader = Buffer.alloc(30 + nameBuffer.length);
        localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
        localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
        localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
        localHeader.writeUInt16LE(8, 8);          // Compression method (Deflate)
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressedSize, 18);
        localHeader.writeUInt32LE(uncompressedSize, 22);
        localHeader.writeUInt16LE(nameBuffer.length, 26);
        localHeader.writeUInt16LE(0, 28);         // Extra field length
        nameBuffer.copy(localHeader, 30);

        localHeaders.push(localHeader, compressedData);

        // Central Directory Header
        const cdHeader = Buffer.alloc(46 + nameBuffer.length);
        cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
        cdHeader.writeUInt16LE(20, 4);         // Version made by
        cdHeader.writeUInt16LE(20, 6);         // Version needed
        cdHeader.writeUInt16LE(0, 8);          // Flags
        cdHeader.writeUInt16LE(8, 10);         // Compression method
        cdHeader.writeUInt16LE(dosTime, 12);
        cdHeader.writeUInt16LE(dosDate, 14);
        cdHeader.writeUInt32LE(crc, 16);
        cdHeader.writeUInt32LE(compressedSize, 20);
        cdHeader.writeUInt32LE(uncompressedSize, 24);
        cdHeader.writeUInt16LE(nameBuffer.length, 28);
        cdHeader.writeUInt16LE(0, 30);         // Extra field length
        cdHeader.writeUInt16LE(0, 32);         // File comment length
        cdHeader.writeUInt16LE(0, 34);         // Disk number start
        cdHeader.writeUInt16LE(0, 36);         // Internal file attributes
        cdHeader.writeUInt32LE(0, 38);         // External file attributes
        cdHeader.writeUInt32LE(offset, 42);     // Relative offset of local header
        nameBuffer.copy(cdHeader, 46);

        cdHeaders.push(cdHeader);

        offset += localHeader.length + compressedData.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const cdh of cdHeaders) {
        cdSize += cdh.length;
    }

    // End of Central Directory Record (EOCD)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4);          // Disk number
    eocd.writeUInt16LE(0, 6);          // Disk with CD
    eocd.writeUInt16LE(files.length, 8); // CD entries on this disk
    eocd.writeUInt16LE(files.length, 10); // Total CD entries
    eocd.writeUInt32LE(cdSize, 12);    // CD size
    eocd.writeUInt32LE(cdStart, 16);   // CD offset
    eocd.writeUInt16LE(0, 20);         // Comment length

    return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

/**
 * Zips specified file paths into a single output zip file path.
 * @param {Array<{ name: string, path: string }>} fileList
 * @param {string} outputPath
 */
function createZipFile(fileList, outputPath) {
    const files = fileList.map(item => {
        const data = fs.readFileSync(item.path);
        return { name: item.name, data };
    });
    const zipBuf = createZipBuffer(files);
    fs.writeFileSync(outputPath, zipBuf);
    return zipBuf;
}

module.exports = {
    createZipBuffer,
    createZipFile,
    calculateCRC32
};
