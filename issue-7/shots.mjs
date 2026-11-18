import { writeFileSync } from 'node:fs';
import { launch, at } from './lib.mjs';

const [url, out, label] = process.argv.slice(2);
const TIMES = (process.env.TIMES || '00:00,03:00,09:10,12:00,15:30,23:50').split(',');
const b = await launch();
const results = [];
await b.load(url, at('00:00'));
const svg = await b.rect('#clock');
for (const t of TIMES) {
  await b.setClock(at(t));
  await b.evalJs('draw()');
  const info = await b.evalJs(`(() => {
    const red = [...document.querySelectorAll('#clock line')].filter(l => l.getAttribute('stroke') === '#e5484d');
    const texts = [...document.querySelectorAll('#clock text')].map(t => t.textContent);
    return {
      redLines: red.length,
      timeLikeTexts: texts.filter(s => /^\\d\\d:\\d\\d$/.test(s)),
      checkboxesInBar: document.querySelectorAll('#bar input[type=checkbox]').length,
      barText: document.querySelector('#bar').innerText,
    };
  })()`);
  await b.shot(`${out}-${t.replace(':', '')}.png`, svg);
  results.push({ frozen: t, ...info });
}
const result = { label, url, exceptions: [...b.st.exceptions], results };
writeFileSync(`${out}-shots-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
b.close();
