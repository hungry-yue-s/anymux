import { describe, expect, it } from 'vitest';
import { parseSsOutput } from '../../lib/ports.js';
import { listListeningPorts, parseLsofOutput, parseNetstatWindowsOutput } from '../../lib/ports/listeners.js';
import { extractAdvertisedUrls } from '../../lib/ports/advertised-urls.js';

describe('Cross-platform Ports discovery & advertised URLs (Orca MIT port)', () => {
  it('parses Linux ss, macOS lsof (-F and tabular), and Windows netstat output', async () => {
    expect(parseSsOutput('LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=42,fd=18))\n')).toEqual([{ port: 3000, pid: 42 }]);

    const lsofField = [
      'p1201',
      'cnode',
      'n*:5173',
      'p1202',
      'cpython3',
      'n127.0.0.1:8000',
      'n127.0.0.1:80',
    ].join('\n');
    expect(parseLsofOutput(lsofField)).toEqual([
      { port: 5173, pid: 1201, address: '*:5173', command: 'node' },
      { port: 8000, pid: 1202, address: '127.0.0.1:8000', command: 'python3' },
    ]);

    const netstatWin = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:4173           0.0.0.0:0              LISTENING       8820',
      '  TCP    127.0.0.1:80           0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:4173         127.0.0.1:50000        ESTABLISHED     8820',
    ].join('\r\n');
    expect(parseNetstatWindowsOutput(netstatWin)).toEqual([
      { port: 4173, pid: 8820, address: '0.0.0.0:4173', command: '' },
    ]);

    const mac = await listListeningPorts({
      platform: 'darwin',
      exec: async () => ({ stdout: lsofField }),
    });
    expect(mac).toHaveLength(2);

    const win = await listListeningPorts({
      platform: 'win32',
      exec: async () => ({ stdout: netstatWin }),
    });
    expect(win).toHaveLength(1);
    expect(win[0].port).toBe(4173);
  });

  it('extracts and normalizes wildcard dev server URLs from ANSI output', () => {
    const output = '\x1b[32m➜  Local:   http://localhost:5173/\n➜  Network: http://0.0.0.0:5173/app\nAPI: http://127.0.0.1:8080\x1b[0m';
    const urls = extractAdvertisedUrls(output);
    expect(urls.map((u) => u.url)).toEqual([
      'http://localhost:5173/',
      'http://localhost:5173/app',
      'http://127.0.0.1:8080/',
    ]);
  });
});
