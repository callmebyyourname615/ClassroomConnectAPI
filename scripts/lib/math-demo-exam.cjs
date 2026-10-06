const { createHash } = require('node:crypto');
const periods = [
    ...[9, 10, 11, 12, 2, 3, 4, 5].map((month, index) => ({ key: `month-${month}`, month, reportMonth: month >= 9 ? month - 8 : month + 4, label: `ເດືອນ ${month}`, index })),
    { key: 'term-1', month: 1, term: 1, label: 'ພາກຮຽນ 1', index: 8 },
    { key: 'term-2', month: 6, term: 2, label: 'ພາກຮຽນ 2', index: 9 },
];
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const fraction = (a, b) => { const divisor = gcd(a, b); return b / divisor === 1 ? String(a / divisor) : `${a / divisor}/${b / divisor}`; };
function buildMathQuestions(className, period) {
    const kindergarten = className.startsWith('ອບ');
    const grade = Number(className.match(/\d+/)?.[0]);
    if (!grade || grade > (kindergarten ? 3 : 5)) throw new Error(`Unsupported math class: ${className}`);
    const questions = [];
    for (let i = 0; i < 10; i++) {
        const value = createHash('sha256').update(`${className}:${period.key}:${i}`).digest().readUInt32BE(0);
        const a = 2 + value % (kindergarten ? 4 : 8), b = 1 + (value >>> 8) % (kindergarten ? 3 : 7);
        let prompt, answer;
        if (kindergarten && grade === 1) {
            const n = 1 + value % 5;
            if (i % 3 === 0) { prompt = `ນັບຈຳນວນ: ${'● '.repeat(n).trim()}`; answer = n; }
            else if (i % 3 === 1) { prompt = `ຂຽນຈຳນວນຖັດຈາກ ${n}`; answer = n + 1; }
            else { prompt = `${n}, ${n + 1}, ____`; answer = n + 2; }
        } else if (kindergarten || grade === 1) {
            const factor = kindergarten && grade === 2 ? 1 : 2;
            if (i % 2 === 0) { prompt = `${a * factor} + ${b} = ____`; answer = a * factor + b; }
            else { prompt = `${a * factor + b} − ${b} = ____`; answer = a * factor; }
        } else if (grade === 2) {
            const first = 10 + value % 70, second = 1 + b;
            if (i % 3 === 0) { prompt = `${first} + ${second} = ____`; answer = first + second; }
            else if (i % 3 === 1) { prompt = `${first} − ${second} = ____`; answer = first - second; }
            else { prompt = `${a} × ${b} = ____`; answer = a * b; }
        } else if (grade === 3) {
            if (i % 3 === 0) { prompt = `${a} × ${b} = ____`; answer = a * b; }
            else if (i % 3 === 1) { prompt = `${a * b} ÷ ${a} = ____`; answer = b; }
            else { prompt = `ປຶ້ມ 1 ເຫຼັ້ມລາຄາ ${a * 1000} ກີບ. ປຶ້ມ ${b} ເຫຼັ້ມລາຄາຈັກກີບ?`; answer = a * b * 1000; }
        } else if (grade === 4) {
            if (i % 4 === 0) { prompt = `${a}/10 + ${b}/10 = ____`; answer = fraction(a + b, 10); }
            else if (i % 4 === 1) { prompt = `${a}.5 + ${b}.2 = ____`; answer = `${a + b}.7`; }
            else if (i % 4 === 2) { prompt = `ຮູບສີ່ແຈສາກຍາວ ${a} ຊມ ແລະ ກວ້າງ ${b} ຊມ. ເນື້ອທີ່ຈັກ ຊມ²?`; answer = a * b; }
            else { prompt = `${a * 12} ÷ ${a} = ____`; answer = 12; }
        } else {
            if (i % 4 === 0) { prompt = `${a}/2 + ${b}/4 = ____`; answer = fraction(2 * a + b, 4); }
            else if (i % 4 === 1) { prompt = `${b * 10}% ຂອງ ${a * 100} ເທົ່າກັບເທົ່າໃດ?`; answer = a * b * 10; }
            else if (i % 4 === 2) { prompt = `ກ່ອງຍາວ ${a} ຊມ, ກວ້າງ ${b} ຊມ, ສູງ 2 ຊມ. ບໍລິມາດຈັກ ຊມ³?`; answer = a * b * 2; }
            else { prompt = `(${a} + ${b}) × 3 = ____`; answer = (a + b) * 3; }
        }
        questions.push({ number: i + 1, prompt, answer: String(answer), points: 1 });
    }
    return questions;
}
module.exports = { periods, buildMathQuestions };
