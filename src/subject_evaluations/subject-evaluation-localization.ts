import { BadRequestException } from '@nestjs/common';
import { parseBilingualName } from '../common/bilingual-name';

export function evaluationTextTranslations(value?: string | null) {
  if (!value?.trim()) return null;
  try {
    return parseBilingualName(value);
  } catch (error) {
    throw new BadRequestException(error.message);
  }
}

export function localizeEvaluationContents<
  T extends { t_title: string; e_title?: string[] },
>(contents: T[]) {
  return contents.map((content) => ({
    ...content,
    t_title_translations: evaluationTextTranslations(content.t_title),
    e_title_translations: (content.e_title || []).map((title) =>
      evaluationTextTranslations(title),
    ),
  }));
}
