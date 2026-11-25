/**
 * 端到端：用户级会话 Storage（~/.wxa-runner/storage/<appid>/<profile>.json）
 * 在 App.onLaunch 之前预注入，支持跨浏览器上下文复用、工具栏「存会话」回写与 --no-session 访客态
 */

import path from 'path';
import { Browser, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { writeSessionStorage } from '../../packages/core/src/server/sessionStore';
import { createProject, REPO_ROOT } from '../helpers';
import { chromeLaunchOptions, e2eReady } from './runner';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
const APPID = 'wxsession0000001';

function createSessionMiniProgram() {
  return createProject({
    'project.config.json': { appid: APPID, compileType: 'miniprogram' },
    'app.json': { pages: ['pages/index/index'] },
    'app.js': `
App({
  globalData: {},
  onLaunch() {
    this.globalData.token = wx.getStorageSync('token-104');
    this.globalData.envKey = wx.getStorageSync('ENV_KEY');
    this.globalData.loggedIn = wx.getStorageSync('isFormLogin');
  }
});
`,
    'app.wxss': '',
    'pages/index/index.json': {},
    'pages/index/index.js': `
Page({
  data: { status: '' },
  onLoad() {
    const g = getApp().globalData;
    this.setData({ status: [g.token || 'guest', typeof g.envKey, String(g.envKey), typeof g.loggedIn, String(g.loggedIn)].join('|') });
  },
  loginNow() {
    wx.setStorageSync('token-104', 'saved-from-browser');
    wx.setStorageSync('ENV_KEY', 2);
    wx.setStorageSync('isFormLogin', true);
    this.setData({ status: 'updated' });
  }
});
`,
    'pages/index/index.wxml': '<view id="status">{{status}}</view><button id="login" bindtap="loginNow">登录</button>',
    'pages/index/index.wxss': ''
  });
}

describe.skipIf(!e2eReady)('用户级会话 Storage 端到端', () => {
  let browser: Browser;
  let server: DevServer | undefined;

  beforeAll(async () => {
    browser = await chromium.launch(chromeLaunchOptions);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('预置的会话 Storage 在 App.onLaunch 前注入并保留原始类型，--no-session 时不注入', async () => {
    const projectPath = createSessionMiniProgram();
    const sessionDir = createProject({});
    writeSessionStorage(APPID, { 'token-104': 'preset-tok', ENV_KEY: 1, isFormLogin: true }, { baseDir: sessionDir });

    server = new DevServer({
      projectPath,
      port: 0,
      watch: false,
      sessionDir,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const url = await server.start();

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto(url);
    await page1.waitForFunction(() => window.__wxa_test_api__);
    const frame1 = page1.frameLocator('.wxa-pages iframe');
    await frame1.locator('#status').waitFor();
    expect(await frame1.locator('#status').textContent()).toBe('preset-tok|number|1|boolean|true');
    await ctx1.close();
    await server.close();

    // --no-session（session: false）以干净访客态启动
    server = new DevServer({
      projectPath,
      port: 0,
      watch: false,
      session: false,
      sessionDir,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const guestUrl = await server.start();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(guestUrl);
    await page2.waitForFunction(() => window.__wxa_test_api__);
    const frame2 = page2.frameLocator('.wxa-pages iframe');
    await frame2.locator('#status').waitFor();
    expect(await frame2.locator('#status').textContent()).toBe('guest|string||string|');
    await ctx2.close();
  });

  it('在浏览器登录后点击「存会话」，全新浏览器上下文自动复现登录态', async () => {
    const projectPath = createSessionMiniProgram();
    const sessionDir = createProject({});

    server = new DevServer({
      projectPath,
      port: 0,
      watch: false,
      sessionDir,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const url = await server.start();

    // 浏览器 1：初始访客态 → 点页面登录写 Storage → 点工具栏「存会话」
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto(url);
    await page1.waitForFunction(() => window.__wxa_test_api__);
    const frame1 = page1.frameLocator('.wxa-pages iframe');
    await frame1.locator('#login').click();
    await frame1.locator('#status', { hasText: 'updated' }).waitFor();

    const saveResp = page1.waitForResponse(res => res.url().endsWith('/__wxa__/session') && res.request().method() === 'POST');
    await page1.locator('.wxa-save-session').click();
    expect((await saveResp).status()).toBe(200);
    await ctx1.close();

    // 浏览器 2（全新隔离 localStorage）：自动读取已保存会话
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await page2.waitForFunction(() => window.__wxa_test_api__);
    const frame2 = page2.frameLocator('.wxa-pages iframe');
    await frame2.locator('#status').waitFor();
    expect(await frame2.locator('#status').textContent()).toBe('saved-from-browser|number|2|boolean|true');
    await ctx2.close();
  });
});
