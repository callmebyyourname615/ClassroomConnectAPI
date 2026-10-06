import { ValidationPipe } from '@nestjs/common';
import { CreateEvaluationDto } from './create-evaluation.dto';
import { UpdateEvaluationDto } from './update-evaluation.dto';

const uuid = '03d90429-71dd-4249-ad56-d6ae7298fb84';
const pipe = new ValidationPipe({ whitelist: true, transform: true });

describe('Evaluation HTTP validation', () => {
  it('retains student, teacher, subject and per-item score when creating', async () => {
    const body = { studentId: uuid, adminId: uuid, subjectId: uuid, classId: uuid, subjectEvaluationId: uuid, score: 10, contentIndex: 3 };
    const result = await pipe.transform({ ...body, ignored: 'extra' }, { type: 'body', metatype: CreateEvaluationDto });
    expect(result).toEqual(body);
  });

  it.each([0, 4, 10])('retains the score %s when editing instead of silently dropping it', async (score) => {
    const result = await pipe.transform({ score, contentIndex: 0 }, { type: 'body', metatype: UpdateEvaluationDto });
    expect(result).toEqual({ score, contentIndex: 0 });
  });

  it('rejects negative scores and fractional item indexes', async () => {
    await expect(pipe.transform({ score: -1 }, { type: 'body', metatype: UpdateEvaluationDto })).rejects.toThrow();
    await expect(pipe.transform({ contentIndex: 0.5 }, { type: 'body', metatype: UpdateEvaluationDto })).rejects.toThrow();
  });
});
