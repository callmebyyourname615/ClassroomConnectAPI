import {
  evaluationTextTranslations,
  localizeEvaluationContents,
} from './subject-evaluation-localization';

describe('portal evaluation text localization', () => {
  it('extracts arbitrary entered names without predefined translations', () => {
    expect(evaluationTextTranslations('ຫົວຂໍ້ໃໝ່(New topic)')).toEqual({
      la: 'ຫົວຂໍ້ໃໝ່',
      en: 'New topic',
    });
    expect(evaluationTextTranslations('')).toBeNull();
  });
  it('keeps pages, maxima, rubric rows and raw text unchanged', () => {
    const contents = [
      {
        maxScore: 9,
        t_title: 'ບົດໃໝ່(New chapter)',
        t_page: '3-5',
        e_title: ['ຂໍ້ໜຶ່ງ(One, two)', 'ຂໍ້ສອງ(Second)'],
        e_page: ['4', '5'],
        e_rows: [{ page: 4, rows: [0, 1] }],
      },
    ];
    const actual = localizeEvaluationContents(contents)[0];
    expect(actual.t_title_translations).toEqual({
      la: 'ບົດໃໝ່',
      en: 'New chapter',
    });
    expect(actual.e_title_translations.map((x) => x?.en)).toEqual([
      'One, two',
      'Second',
    ]);
    expect(actual.t_title).toBe(contents[0].t_title);
    expect(actual.t_page).toBe('3-5');
    expect(actual.maxScore).toBe(9);
    expect(actual.e_page).toEqual(['4', '5']);
    expect(actual.e_rows).toEqual([{ page: 4, rows: [0, 1] }]);
    expect(contents[0]).not.toHaveProperty('t_title_translations');
  });
  it('rejects incomplete parenthesized translations', () => {
    expect(() =>
      localizeEvaluationContents([{ t_title: 'ບົດ(Chapter' }]),
    ).toThrow();
  });
});
