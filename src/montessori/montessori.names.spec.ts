import { montessoriStudentName } from './montessori.names';

describe('Montessori student name locale data', () => {
  it('retains both name columns for locale selection', () => {
    expect(
      montessoriStudentName({
        first_name_lao: 'ສົມ',
        last_name_lao: 'ໃຈ',
        first_name_eng: 'Som',
        last_name_eng: 'Jai',
      }),
    ).toBe('ສົມ ໃຈ(Som Jai)');
  });
  it('keeps names that already follow the bilingual input concept', () => {
    expect(
      montessoriStudentName({
        first_name_lao: 'ສົມ(Som)',
        last_name_lao: 'ໃຈ(Jai)',
      }),
    ).toBe('ສົມ(Som) ໃຈ(Jai)');
    expect(
      montessoriStudentName({
        first_name_lao: 'ສົມ(Som)',
        first_name_eng: 'Som',
      }),
    ).toBe('ສົມ(Som)');
  });
  it('preserves a single-language fallback and malformed legacy input', () => {
    expect(montessoriStudentName({ first_name_eng: 'Som' })).toBe('Som');
    expect(montessoriStudentName({ first_name_lao: 'ສົມ' })).toBe('ສົມ');
    expect(
      montessoriStudentName({ first_name_lao: 'ສົມ(', first_name_eng: 'Som' }),
    ).toBe('ສົມ(');
  });
});
