import { parseBilingualName } from '../common/bilingual-name';

/** Keep both existing student name columns available to the portal's locale formatter. */
export function montessoriStudentName(student: {
  first_name_lao?: string;
  last_name_lao?: string;
  first_name_eng?: string;
  last_name_eng?: string;
}) {
  const lao = [student.first_name_lao, student.last_name_lao]
    .filter(Boolean)
    .join(' ')
    .trim();
  const english = [student.first_name_eng, student.last_name_eng]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!lao) return english || 'Student';
  if (!english || lao === english) return lao;
  try {
    const parsed = parseBilingualName(lao);
    return `${parsed.la}(${english})`;
  } catch {
    // Malformed legacy input remains visible without inventing a translation.
    return lao;
  }
}
