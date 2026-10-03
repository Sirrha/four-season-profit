// pdf-print.mjs — child process for P04: generates the fixture PDF in a FRESH process and prints its identity + raw sha.
import { createHash } from 'node:crypto';
import { frozenEmployee1 } from './fixtures.mjs';
import { generateContractPdf } from '../src/contract-pdf.mjs';
const r = await generateContractPdf(frozenEmployee1().version);
console.log(JSON.stringify(Object.assign({}, r.identity, { rawSha256: createHash('sha256').update(r.bytes).digest('hex'), pid: process.pid })));
