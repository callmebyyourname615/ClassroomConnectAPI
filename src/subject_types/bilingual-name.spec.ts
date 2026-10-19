import { parseBilingualName } from '../common/bilingual-name';
import { SubjectTypeService } from './subject-type.service';

describe('bilingual subject type names', () => {
  it.each([
    ['ຄະນິດສາດ(Math)', { la: 'ຄະນິດສາດ', en: 'Math' }],
    [' ຄະນິດສາດ ( Math ) ', { la: 'ຄະນິດສາດ', en: 'Math' }],
    ['ຄະນິດສາດ(Math (Advanced))', { la: 'ຄະນິດສາດ', en: 'Math (Advanced)' }],
    ['ຄະນິດສາດ(Math)(Advanced)', { la: 'ຄະນິດສາດ', en: 'Math Advanced' }],
    ['ຄະນິດສາດ', { la: 'ຄະນິດສາດ', en: null }],
    ['Legacy name', { la: 'Legacy name', en: null }],
  ])('parses %s', (source, expected) => {
    expect(parseBilingualName(source)).toEqual(expected);
  });
  it.each([' ', 'ຄະນິດສາດ()', 'ຄະນິດສາດ(Math', 'ຄະນິດສາດMath)', '(Math)'])(
    'rejects incomplete format %s',
    (source) => {
      expect(() => parseBilingualName(source)).toThrow();
    },
  );
  it('stores translations on create and clears old English on a Lao-only edit', async () => {
    let record: any;
    const repo: any = {
      findOne: jest.fn(async ({ where }) => (where.id ? record : null)),
      create: (value) => value,
      save: jest.fn(async (value) => (record = { id: 'type', ...value })),
    };
    const cache: any = { del: jest.fn(), delPattern: jest.fn() };
    const service = new SubjectTypeService(repo, cache);
    const created = await service.create({ name: 'ຄະນິດສາດ(Math)' });
    expect(created.name).toBe('ຄະນິດສາດ(Math)');
    expect(created.name_translations).toEqual({ la: 'ຄະນິດສາດ', en: 'Math' });
    const edited = await service.update('type', { name: 'ວິທະຍາສາດ' });
    expect(edited.name_translations).toEqual({ la: 'ວິທະຍາສາດ', en: null });
    await expect(service.create({ name: 'ວິທະຍາສາດ()' })).rejects.toThrow();
    expect(repo.save).toHaveBeenCalledTimes(2);
  });
});
