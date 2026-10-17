import { EvaluationController } from './evaluation.controller';

describe('Evaluation notification trigger permissions', () => {
  it('prevents a parent session from writing evaluation scores', () => {
    const service: any = {
      create: jest.fn(),
      updateScore: jest.fn(),
      remove: jest.fn(),
    };
    const controller = new EvaluationController(service);
    const parent = { user: { sub: 'parent-a', user_type: 'parent' } };
    expect(() => controller.create({} as any, parent)).toThrow(
      'Staff account required',
    );
    expect(() => controller.updateScore(1, { score: 10 }, parent)).toThrow(
      'Staff account required',
    );
    expect(() => controller.remove(1, parent)).toThrow(
      'Staff account required',
    );
    expect(service.create).not.toHaveBeenCalled();
    expect(service.updateScore).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });
});
