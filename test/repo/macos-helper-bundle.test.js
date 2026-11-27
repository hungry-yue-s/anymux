import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_MAC_APP_ID,
  deriveExecutableUuid,
  formatUuid,
  readMachOUuids,
  rewriteMachOUuids,
} from '../../scripts/macos-executable-uuid.mjs';
import {
  buildHelperInfoPlist,
  createHelperBundle,
  FORBIDDEN_HELPER_INFO_KEYS,
  parseCodesignAuthority,
  readAppInfoMetadata,
  resolveSigningIdentity,
} from '../../scripts/macos-helper-bundle.mjs';

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function makeMinimalMachO64(cpuType = 0x0100000c, initialUuid = Buffer.alloc(16, 0x11)) {
  const headerSize = 32;
  const cmdSize = 24;
  const buf = Buffer.alloc(headerSize + cmdSize);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpuType >>> 0, 4);
  buf.writeUInt32LE(1, 16); // ncmds
  buf.writeUInt32LE(cmdSize, 20);
  buf.writeUInt32LE(0x1b, headerSize); // LC_UUID
  buf.writeUInt32LE(cmdSize, headerSize + 4);
  initialUuid.copy(buf, headerSize + 8);
  return buf;
}

describe('macos-executable-uuid & helper bundle', () => {
  it('derives deterministic per-(appId, executable, cpuType) UUIDs', () => {
    const a1 = formatUuid(deriveExecutableUuid('com.anymux.app', 'Anymux', 0x0100000c));
    const a2 = formatUuid(deriveExecutableUuid('com.anymux.app', 'Anymux', 0x0100000c));
    const otherApp = formatUuid(deriveExecutableUuid('com.example.other', 'Anymux', 0x0100000c));
    const otherCpu = formatUuid(deriveExecutableUuid('com.anymux.app', 'Anymux', 0x01000007));

    expect(a1).toBe(a2);
    expect(a1).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(otherApp).not.toBe(a1);
    expect(otherCpu).not.toBe(a1);
  });

  it('rewrites LC_UUID in thin and fat Mach-O buffers', () => {
    const thin = makeMinimalMachO64(0x0100000c);
    const changes = rewriteMachOUuids(thin, DEFAULT_MAC_APP_ID, 'Anymux');
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('11111111-1111-1111-1111-111111111111');
    expect(changes[0].after).toBe(formatUuid(deriveExecutableUuid(DEFAULT_MAC_APP_ID, 'Anymux', 0x0100000c)));
    expect(readMachOUuids(thin)[0].uuid).toBe(changes[0].after);

    const slice1 = makeMinimalMachO64(0x0100000c);
    const slice2 = makeMinimalMachO64(0x01000007);
    const fatHeader = 8 + 2 * 20;
    const fat = Buffer.alloc(fatHeader + slice1.length + slice2.length);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(fatHeader, 16);
    fat.writeUInt32BE(slice1.length, 20);
    fat.writeUInt32BE(0x01000007, 28);
    fat.writeUInt32BE(fatHeader + slice1.length, 36);
    fat.writeUInt32BE(slice2.length, 40);
    slice1.copy(fat, fatHeader);
    slice2.copy(fat, fatHeader + slice1.length);

    const fatChanges = rewriteMachOUuids(fat, DEFAULT_MAC_APP_ID, 'Anymux');
    expect(fatChanges).toHaveLength(2);
    expect(fatChanges[0].after).not.toBe(fatChanges[1].after);
  });

  it('resolves signing identity from app Authority when present in keychain', () => {
    const execMock = (cmd, args) => {
      if (cmd === '/usr/bin/security') {
        return '  1) AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555 "HaoDouDou Dev"\n  2) FFFF1111BBBB2222CCCC3333DDDD4444EEEE5555 "Other Cert"\n';
      }
      if (cmd === '/usr/bin/codesign') {
        return 'Identifier=com.anymux.app\nAuthority=HaoDouDou Dev\n';
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };
    const appFixture = mkdtempSync(join(tmpdir(), 'anymux-app-fixture-'));
    cleanups.push(() => rmSync(appFixture, { recursive: true, force: true }));
    expect(resolveSigningIdentity({ explicit: '', appCandidates: [appFixture], execFileSyncFn: execMock })).toBe('HaoDouDou Dev');
    expect(parseCodesignAuthority('Authority=Developer ID Application: Test\n')).toBe('Developer ID Application: Test');
    expect(parseCodesignAuthority('Signature=adhoc\n')).toBeNull();
  });

  it.skipIf(process.platform !== 'darwin')('builds a signed helper .app bundle sharing Info.plist usage descriptions and aligned LC_UUID', () => {
    const appInfo = resolve(import.meta.dirname, '../../macos/Anymux/Resources/Info.plist');
    const meta = readAppInfoMetadata(appInfo);
    expect(meta.appId).toBe('com.anymux.app');
    expect(meta.usageDescriptions.NSDesktopFolderUsageDescription).toBeTruthy();
    expect(meta.usageDescriptions.NSLocalNetworkUsageDescription).toBeTruthy();

    const plist = buildHelperInfoPlist({
      bundleName: 'Anymux Tmux',
      appId: meta.appId,
      shortVersion: meta.shortVersion,
      usageDescriptions: meta.usageDescriptions,
    });
    for (const forbidden of FORBIDDEN_HELPER_INFO_KEYS) {
      expect(Object.hasOwn(plist, forbidden)).toBe(false);
    }
    expect(plist.CFBundleVersion).toBe('0');
    expect(plist.LSUIElement).toBe(true);

    const temp = mkdtempSync(join(tmpdir(), 'anymux-helper-bundle-'));
    cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
    const sourceBin = join(temp, 'true-bin');
    copyFileSync('/usr/bin/true', sourceBin);
    const outBundle = join(temp, 'Helpers', 'Anymux Tmux.app');

    const result = createHelperBundle({
      sourceBinary: sourceBin,
      outputBundle: outBundle,
      bundleName: 'Anymux Tmux',
      appInfoPlist: appInfo,
      identity: '-',
    });

    expect(existsSync(result.executablePath)).toBe(true);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', outBundle]);
    const infoJson = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(outBundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }),
    );
    expect(infoJson.CFBundleIdentifier).toBe('com.anymux.app');
    expect(infoJson.LSUIElement).toBe(true);
    expect(infoJson.NSDesktopFolderUsageDescription).toBe(meta.usageDescriptions.NSDesktopFolderUsageDescription);
  });

  it('includes AssociatedBundleIdentifiers, Interactive ProcessType, and MaterializeDatalessFiles in macOS LaunchAgent templates', () => {
    const installer = readFileSync(resolve(import.meta.dirname, '../../scripts/install-service.sh'), 'utf8');
    const tmuxPart = installer.slice(
      installer.indexOf('install_tmux_server_launchd()'),
      installer.indexOf('uninstall_tmux_server_launchd()'),
    );
    expect(tmuxPart).toContain('<key>AssociatedBundleIdentifiers</key>');
    expect(tmuxPart).toContain('<string>com.anymux.app</string>');
    expect(tmuxPart).toContain('<string>Interactive</string>');
    expect(tmuxPart).toContain('<key>MaterializeDatalessFiles</key>');

    const panelPart = installer.slice(
      installer.indexOf('install_launchd()'),
      installer.indexOf('uninstall_launchd()'),
    );
    expect(panelPart).toContain('<key>AssociatedBundleIdentifiers</key>');
    expect(panelPart).toContain('<key>MaterializeDatalessFiles</key>');
  });
});
