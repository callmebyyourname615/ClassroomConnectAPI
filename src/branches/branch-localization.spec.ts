import { BranchService } from './branch.service';

describe('branch bilingual names', () => {
  const setup = (deleted = false) => {
    let record: any = {
      id: 'branch-test',
      name: 'ສາຂາເກົ່າ(Old branch)',
      name_translations: { la: 'ສາຂາເກົ່າ', en: 'Old branch' },
      is_deleted: deleted,
      subjects: [],
    };
    const repo: any = {
      findOne: jest.fn(async ({ where }) =>
        Array.isArray(where) && deleted ? record : null,
      ),
      create: (value: any) => value,
      save: jest.fn(
        async (value: any) => (record = { id: 'branch-test', ...value }),
      ),
      createQueryBuilder: () => ({
        leftJoinAndSelect() {
          return this;
        },
        leftJoinAndMapOne() {
          return this;
        },
        where() {
          return this;
        },
        getOne: async () => record,
      }),
    };
    return {
      service: new BranchService(
        repo,
        { find: async () => [] } as any,
        { del: jest.fn() } as any,
      ),
      repo,
    };
  };

  it('creates a name with API translations and keeps the editable original', async () => {
    const { service } = setup();
    const result = await service.create({
      branch_id: 'BR1',
      branch_no: 'NO1',
      name: 'ສາຂາໃໝ່(New branch)',
    });
    expect(result.name).toBe('ສາຂາໃໝ່(New branch)');
    expect(result.name_translations).toEqual({
      la: 'ສາຂາໃໝ່',
      en: 'New branch',
    });
  });
  it('resurrects a deleted branch with fresh translations', async () => {
    const { service } = setup(true);
    const result = await service.create({
      branch_id: 'BR1',
      branch_no: 'NO1',
      name: 'ສາຂາໃໝ່(New branch)',
    });
    expect(result.name_translations?.en).toBe('New branch');
    expect(result.is_deleted).toBe(false);
  });
  it('clears old English when an edit has only a Lao name', async () => {
    const { service } = setup();
    const result = await service.update('branch-test', { name: 'ສາຂາໃໝ່' });
    expect(result.name_translations).toEqual({ la: 'ສາຂາໃໝ່', en: null });
  });
  it('keeps translations on an unrelated edit', async () => {
    const { service } = setup();
    const result = await service.update('branch-test', { phone: '1234' });
    expect(result.name_translations).toEqual({
      la: 'ສາຂາເກົ່າ',
      en: 'Old branch',
    });
  });
  it.each(['ສາຂາ()', 'ສາຂາ(New', 'ສາຂາNew)', '(New)', 'x'.repeat(256)])(
    'rejects invalid create/update names before saving: %s',
    async (name) => {
      const { service, repo } = setup();
      await expect(
        service.create({ branch_id: 'BR1', branch_no: 'NO1', name }),
      ).rejects.toThrow();
      await expect(service.update('branch-test', { name })).rejects.toThrow();
      expect(repo.save).not.toHaveBeenCalled();
    },
  );
});
