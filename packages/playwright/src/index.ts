/**
 * @open-wxa/wxa-runner-playwright：在 Playwright 里测试小程序
 *
 *   import { test, expect } from '@open-wxa/wxa-runner-playwright';
 *
 *   test('下单', async ({ miniProgram }) => {
 *     await miniProgram.open('pages/index/index');
 *     ...
 *   });
 */

import path from 'path';
import { expect as baseExpect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DevServer } from '@open-wxa/wxa-runner-core';
import { withEagerSourcePositions } from './launchOptions';
import { miniProgramMatchers } from './matchers';
import { createMiniProgram, MiniProgram } from './miniProgram';
import { devServerOptions, WxaServerOptions } from './server';

export type { MiniProgram, MockHandler, RouteHandler } from './miniProgram';
export type { MiniProgramRequest } from './request';
export type { WebViewInfo } from '@open-wxa/wxa-runner-core';
export type { WxaServerOptions } from './server';

/** 在 playwright.config.ts 的 use 里配置，或在用例文件里用 test.use 修改 */
export interface WxaOptions {
  /**
   * 小程序项目目录（project.config.json 所在目录）。相对路径基于 Playwright 配置文件所在目录，默认就是这个目录。
   * 每个 worker 启动一个开发服务器，所以只能在配置文件或用例文件顶层修改（test.use），修改后 Playwright 会换一个 worker
   */
  wxaProject: string;
  /** 开发服务器的其余参数，其中 setup 等路径也相对配置文件所在目录。同 wxaProject，只能在配置文件或用例文件顶层修改 */
  wxaServerOptions: WxaServerOptions;
  /** 用例结束时检查 errors() 为空，默认 true。有意触发运行时错误的用例用 test.use({ wxaCheckErrors: false }) 关掉 */
  wxaCheckErrors: boolean;
  /**
   * web-view 的网页怎么打开，默认 'iframe'：嵌在模拟器里，网页和模拟器域名不同时，SameSite 为 Lax、Strict 或没写的 Cookie 不生效。
   * 'window' 在新窗口里打开，网页是顶层页面，Cookie 能正常使用，用 miniProgram.webView() 拿到网页窗口。可以按用例修改
   */
  wxaWebView: 'iframe' | 'window';
  /**
   * 'window' 模式下 H5 窗口的 User-Agent。默认是微信内置浏览器的 UA，并自动补上 `miniProgram/<appid>`：
   * 有些 H5 先看 UA 里有没有这一段，没有就跳去微信授权页，所以在模拟器里补上。
   * 传 null 关掉，或传别的值完全自己控制
   */
  wxaWebViewUserAgent: string | null;
}

/** 微信内置浏览器的 UA：真正打开窗口时还会拼上 `miniProgram/<appid>`，网关靠它判断是不是小程序里的 web-view */
export const WECHAT_WEBVIEW_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003231) NetType/WIFI Language/zh_CN';

export interface WxaFixtures {
  /** 当前用例的小程序：每个用例一个新的浏览器上下文，Storage、页面栈互不影响 */
  miniProgram: MiniProgram;
}

export interface WxaWorkerFixtures {
  /** 本 worker 的开发服务器，所有用例共用：编译只做一次 */
  wxaServer: DevServer;
}

const ERRORS_HINT = '小程序有运行时错误，或调用了未实现的 wx API（用到的请 mock）。有意触发错误的用例可以 test.use({ wxaCheckErrors: false })';

export const test = base.extend<
  WxaFixtures & Pick<WxaOptions, 'wxaCheckErrors' | 'wxaWebView' | 'wxaWebViewUserAgent'>,
  WxaWorkerFixtures & Pick<WxaOptions, 'wxaProject' | 'wxaServerOptions'>
>({
  wxaProject: ['.', { scope: 'worker', option: true }],
  wxaServerOptions: [{}, { scope: 'worker', option: true }],
  wxaCheckErrors: [true, { option: true }],
  wxaWebView: ['iframe', { option: true }],
  wxaWebViewUserAgent: [WECHAT_WEBVIEW_USER_AGENT, { option: true }],

  // 配置文件 use 里的 launchOptions 照常传进来；用例文件里 test.use({ launchOptions }) 会整个替换掉这里，不再追加
  launchOptions: [async ({ launchOptions, browserName }, use) => {
    await use(browserName === 'chromium' ? { ...launchOptions, args: withEagerSourcePositions(launchOptions.args) } : launchOptions);
  }, { scope: 'worker' }],

  wxaServer: [async ({ wxaProject, wxaServerOptions }, use, workerInfo) => {
    const configDir = workerInfo.config.configFile ? path.dirname(workerInfo.config.configFile) : process.cwd();
    const server = new DevServer(devServerOptions(configDir, wxaProject, wxaServerOptions));
    await server.start();
    await use(server);
    await server.close();
  }, { scope: 'worker', timeout: 60000 }],

  miniProgram: async ({ page, wxaServer, wxaCheckErrors, wxaWebView, wxaWebViewUserAgent, browserName }, use) => {
    if (wxaWebView === 'window') {
      const context = page.context();
      // 微信里 webview 的 UA 带 miniProgram/<appid>，H5 常按它判断是不是小程序里打开的：
      // 没有这一段可能直接跳去微信授权页
      const userAgent =
        wxaWebViewUserAgent === null
          ? null
          : wxaWebViewUserAgent === WECHAT_WEBVIEW_USER_AGENT
            ? `${WECHAT_WEBVIEW_USER_AGENT} miniProgram/${wxaServer.project.runtimeAppid}`
            : wxaWebViewUserAgent;
      if (userAgent && browserName === 'chromium') {
        const applyUserAgent = async (target: Page) => {
          try {
            const cdp = await context.newCDPSession(target);
            await cdp.send('Emulation.setUserAgentOverride', { userAgent });
          } catch {
            // 页面已经关了
          }
        };
        context.on('page', target => {
          if (target !== page) void applyUserAgent(target);
        });
      }
    }
    const session = await createMiniProgram(page, {
      baseURL: wxaServer.url,
      listPages: () => wxaServer.builder.build().then(build => build.pages, () => null),
      webViewWindow: wxaWebView === 'window'
    });
    await use(session.miniProgram);

    session.throwHandlerError();
    if (wxaCheckErrors) baseExpect(await session.miniProgram.errors(), ERRORS_HINT).toEqual([]);
  }
});

export const expect = baseExpect.extend(miniProgramMatchers);
