import { resourceWebPreviewIntent } from '../resource-web-preview';

/** Bundle-only fixture; never loads an NSH engine, browser, Host or device. */
export const resourceWebPreviewFixture = {
  html: resourceWebPreviewIntent({ directory: '/fixture', path: '/fixture/index.html' }),
  loopback: resourceWebPreviewIntent({ directory: '/fixture', href: 'http://localhost:3000/report' }),
  eficy: resourceWebPreviewIntent({ directory: '/fixture', path: '/fixture/report.eficy' }),
  files: {
    '/fixture/index.html': '<!doctype html><html><head><link rel="stylesheet" href="./style.css"><script src="./app.js" defer></script></head><body><h1 id="result">Fixture</h1></body></html>',
    '/fixture/style.css': 'h1 { color: rgb(20, 90, 160); }',
    '/fixture/app.js': 'document.querySelector("#result").textContent = "Resource fixture ready";',
  },
};
