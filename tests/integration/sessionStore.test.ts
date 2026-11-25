/**
 * 用户级会话 Storage 仓库（P1）与开发者工具 Automator Storage 拉取（P2）集成测试
 */

import fs from 'fs';
import http from 'http';
import { once } from 'events';
import { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullDevtoolsStorage } from '../../packages/core/src/server/developerTicket';
import {
  clearSessionStorage,
  listSessionProfiles,
  readSessionStorage,
  sessionRouter,
  writeSessionStorage
} from '../../packages/core/src/server/sessionStore';
import { createProject } from '../helpers';

const SILENT = { log: () => undefined };
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

describe('用户级会话 Storage 仓库', () => {
  it('按 appid 和 profile 持久化并保留原始类型，支持列举和清除', () => {
    const baseDir = createProject({});
    const payload = {
      ENV_KEY: 1,
      isTest: true,
      isFormLogin: false,
      identity: '5',
      profile: { seniorId: 4900749414, tags: ['a', 'b'] }
    };

    const saved = writeSessionStorage('wx-demo', payload, { profile: 'itest', source: 'devtools', baseDir });
    expect(saved.keys).toEqual(Object.keys(payload));

    const loaded = readSessionStorage('wx-demo', 'itest', baseDir);
    expect(loaded).toMatchObject({
      appid: 'wx-demo',
      profile: 'itest',
      source: 'devtools',
      storage: payload
    });

    expect(listSessionProfiles('wx-demo', baseDir)).toEqual([
      expect.objectContaining({ profile: 'itest', keys: 5, source: 'devtools' })
    ]);

    expect(clearSessionStorage('wx-demo', 'itest', baseDir)).toBe(true);
    expect(readSessionStorage('wx-demo', 'itest', baseDir)).toBeNull();
    expect(clearSessionStorage('wx-demo', 'itest', baseDir)).toBe(false);
  });

  it('拒绝非法 appid 或路径穿越会话名', () => {
    const baseDir = createProject({});
    expect(() => writeSessionStorage('../evil', {}, { baseDir })).toThrow('非法的appid');
    expect(() => readSessionStorage('wx-demo', '../secret', baseDir)).toThrow('非法的会话名');
  });

  it('HTTP 接口支持读写删除，并拦截非本机 Host 防 DNS rebinding', async () => {
    const baseDir = createProject({});
    const app = express();
    app.use('/__wxa__/session', sessionRouter('wx-demo', 'default', { baseDir }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise(resolve => server.close(resolve)));
    const { port } = server.address() as AddressInfo;

    const request = (method: string, body?: object, host = `127.0.0.1:${port}`): Promise<{ status: number; body: any }> =>
      new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/__wxa__/session',
            method,
            headers: {
              Host: host,
              ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
          },
          res => {
            let text = '';
            res.on('data', chunk => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
          }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });

    expect(await request('GET')).toEqual({
      status: 200,
      body: { profile: 'default', storage: null, updatedAt: null, source: null }
    });

    const saved = await request('POST', { storage: { ENV_KEY: 1, isTest: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.keys).toEqual(['ENV_KEY', 'isTest']);

    const fetched = await request('GET');
    expect(fetched.status).toBe(200);
    expect(fetched.body.storage).toEqual({ ENV_KEY: 1, isTest: true });
    expect(fetched.body.source).toBe('browser');

    // 伪造 Host 头被 onlyLoopback 拦截
    expect(await request('GET', undefined, `evil.example:${port}`)).toEqual({
      status: 403,
      body: { error: '会话接口只允许本机访问' }
    });

    const cleared = await request('DELETE');
    expect(cleared).toEqual({ status: 200, body: { profile: 'default', cleared: true } });
  });
});

describe('Automator 拉取开发者工具 Storage', () => {
  const CLI_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { stdout, exitCode } = JSON.parse(fs.readFileSync(path.join(__dirname, 'reply.json'), 'utf8'));
process.stdout.write(stdout);
process.exit(exitCode);
`;

  function installFakeElectronDevtools(stdout: string) {
    const windows = process.platform === 'win32';
    const root = createProject(
      windows
        ? {
            'resources/app.asar.unpacked/package.json': {},
            'cli.bat': `@"${process.execPath}" "%~dp0cli.js" %*\r\n`,
            'cli.js': CLI_SCRIPT
          }
        : {
            'Contents/Resources/app.asar.unpacked/package.json': {},
            'Contents/MacOS/cli': CLI_SCRIPT
          }
    );
    const dir = windows ? root : path.join(root, 'Contents/MacOS');
    fs.writeFileSync(path.join(dir, 'reply.json'), JSON.stringify({ stdout, exitCode: 0 }));
    if (!windows) fs.chmodSync(path.join(dir, 'cli'), 0o755);
    vi.stubEnv('WXA_DEVTOOLS_PATH', root);
  }

  it('通过 App.callWxMethod 批量拉取 Storage 并保留原生类型', async () => {
    const store: Record<string, unknown> = {
      ENV_KEY: 1,
      isFormLogin: true,
      identity: '5',
      userMeta: { id: 42, roles: ['member'] }
    };

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    cleanups.push(() => {
      wss.clients.forEach(c => c.terminate());
      return new Promise(resolve => wss.close(resolve));
    });
    const { port } = wss.address() as AddressInfo;

    wss.on('connection', socket => {
      socket.on('message', raw => {
        const { id, method, params } = JSON.parse(String(raw));
        if (method === 'App.callWxMethod' && params.method === 'getStorageInfoSync') {
          socket.send(JSON.stringify({ id, result: { result: { keys: [...Object.keys(store), 'missingKey'] } } }));
        } else if (method === 'App.callWxMethod' && params.method === 'getStorageSync') {
          const key = params.args[0];
          const value = key in store ? store[key] : undefined;
          socket.send(JSON.stringify({ id, result: value === undefined ? {} : { result: value } }));
        }
      });
    });

    installFakeElectronDevtools(JSON.stringify({ command: 'agent-start', status: 'ok', autoPort: port }, null, 2));

    const pulled = await pullDevtoolsStorage(createProject({}), SILENT);
    expect(pulled).toEqual(store);
  });

  it('未找到新版 Electron 开发者工具时给出清晰提示', async () => {
    vi.stubEnv('WXA_DEVTOOLS_PATH', createProject({ 'code/package.nw/package.json': {} }));
    await expect(pullDevtoolsStorage(createProject({}), SILENT)).rejects.toThrow('需要新版微信开发者工具（Electron）');
  });
});
