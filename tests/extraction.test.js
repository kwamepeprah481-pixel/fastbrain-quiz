const path = require('path');
const materials = require(path.join(__dirname, '..', 'routes', 'materials.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
    failures++;
  }
}

function run(label, text) {
  const qs = materials.extractQuestions(text);
  console.log(`\n== ${label} (${qs.length} questions) ==`);
  qs.forEach((q, i) => console.log(`Q${i + 1}: ${JSON.stringify(q.o)} ans=${q.a}`));
  return qs;
}

// 1. DOCX multilevel list: questions top-level, options nested lettered.
const html = `<ol>
<li>1. A rod appears bent when immersed in water. Which property of light is demonstrated?<ol>
<li>Refraction</li><li>Reflection</li><li>Dispersion</li><li>Rectilinear propagation</li>
</ol></li>
<li>2. All the following are abiotic factors of an arboreal ecosystem except<ol>
<li>Plant</li><li>Light Intensity</li><li>Humidity</li><li>Temperature</li>
</ol></li>
</ol>`;
const docxText = materials.htmlToPlainText(html);
const qs1 = run('DOCX multilevel', docxText);
check('DOCX has 2 questions', qs1.length === 2, `got ${qs1.length}`);
check('DOCX Q1 options', JSON.stringify(qs1[0]?.o) === JSON.stringify(['Refraction', 'Reflection', 'Dispersion', 'Rectilinear propagation']), JSON.stringify(qs1[0]?.o));
check('DOCX Q1 clean question', qs1[0]?.q === 'A rod appears bent when immersed in water. Which property of light is demonstrated?', qs1[0]?.q);

// 2. Mixed format: roman numerals + lettered options.
const mixed = `6. Which of the following insect(s) show(s) the egg, nymph and adult stages in its life cycle?
I. Grasshopper
II. Housefly
III. Mosquito
a. I only
b. I and III only
c. II and III only
d. I, II and III
7. The following are examples of terrestrial ecosystem except …
a. Rain forest
b. Savannah
c. Tundra
d. Marine`;
const qs2 = run('Mixed roman + lettered', mixed);
check('Mixed Q6 lettered options', JSON.stringify(qs2[0]?.o) === JSON.stringify(['I only', 'I and III only', 'II and III only', 'I, II and III']), JSON.stringify(qs2[0]?.o));
check('Mixed Q7 starts at correct index', JSON.stringify(qs2[1]?.o) === JSON.stringify(['Rain forest', 'Savannah', 'Tundra', 'Marine']), JSON.stringify(qs2[1]?.o));

// 3. Flat sequential numbering (questions and options share one list).
const flat = `11. The irregular emptying of bowels is the cause of
12. Diarrhoea
13. Constipation
14. Headache
15. Stomach ache
16. The first step in digestion of fats in the body is that
17. Bile breaks down fat in the gall bladder
18. Bile breaks down fat in the duodenum
19. Lipase breaks down the fat in the pancreas.
20. Lipase breaks down the fat in the ileum.`;
const qs3 = run('Flat sequential numbering', flat);
check('Flat has 2 questions', qs3.length === 2, `got ${qs3.length}`);
check('Flat Q1 options', JSON.stringify(qs3[0]?.o) === JSON.stringify(['Diarrhoea', 'Constipation', 'Headache', 'Stomach ache']), JSON.stringify(qs3[0]?.o));
check('Flat Q2 options', JSON.stringify(qs3[1]?.o) === JSON.stringify([
  'Bile breaks down fat in the gall bladder',
  'Bile breaks down fat in the duodenum',
  'Lipase breaks down the fat in the pancreas.',
  'Lipase breaks down the fat in the ileum.'
]), JSON.stringify(qs3[1]?.o));

// 4. Plain lettered options with answer key.
const answerKey = `1. What is 2+2?
A. 3
B. 4
C. 5
D. 6
Answer: B`;
const qs4 = run('Answer key', answerKey);
check('Answer key parsed', qs4[0]?.a === 1, `got ${qs4[0]?.a}`);
check('Answer key options', JSON.stringify(qs4[0]?.o) === JSON.stringify(['3', '4', '5', '6']), JSON.stringify(qs4[0]?.o));

// 5. Instruction line is attached to the following question as a section heading.
const instr = `Choose the correct answer from the options A to D.
1. What is the capital of Ghana?
A. Kumasi
B. Accra
C. Tamale
D. Takoradi`;
const qs5 = run('Instruction capture', instr);
check('Instruction captured', qs5[0]?.q?.startsWith('__SECTION__'), qs5[0]?.q);

// 6. Bold markers around a question are stripped.
const bold = `**1. Which planet is closest to the sun?**
A. Mercury
B. Venus
C. Earth
D. Mars`;
const qs6 = run('Bold question', bold);
check('Bold question parsed', qs6.length === 1 && qs6[0].q === 'Which planet is closest to the sun?', JSON.stringify(qs6[0]?.q));

// 7. Inline options where the next question's option text contains the word
// "key" must not swallow that question via the answer-key lookahead.
const keyWord = `37. 'Thin' begins with the same consonant sound as ______.
A. three     B. those     C. there     D. then

38. 'Kite' begins with the same initial consonant sound as ______.
A. sugar     B. city     C. key     D. giant`;
const qs7 = run('Option word "key" lookahead', keyWord);
check('Option "key" keeps both questions', qs7.length === 2, `got ${qs7.length}`);
check('Option "key" Q2 is the kite question', JSON.stringify(qs7[1]?.o) === JSON.stringify(['sugar', 'city', 'key', 'giant']), JSON.stringify(qs7[1]?.o));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
