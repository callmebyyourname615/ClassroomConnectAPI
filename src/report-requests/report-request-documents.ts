import { BadRequestException, ConflictException } from '@nestjs/common';

export type RequestedDocument = { documentType: string; subjectSlot?: string };

export function requestedDocuments(body: any): RequestedDocument[] | undefined {
  if (body.documents === undefined) return undefined;
  if (
    !Array.isArray(body.documents) ||
    !body.documents.length ||
    body.documents.length > 32 ||
    body.documentType !== undefined ||
    body.subjectSlot !== undefined
  )
    throw new BadRequestException(
      'Select between 1 and 32 documents without mixing single-document fields.',
    );
  const seen = new Set<string>();
  const documents = body.documents.map((d: any) => {
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      typeof d.documentType !== 'string' ||
      !d.documentType ||
      d.documentType.length > 64 ||
      (d.subjectSlot !== undefined &&
        (typeof d.subjectSlot !== 'string' ||
          !d.subjectSlot ||
          d.subjectSlot.length > 64))
    )
      throw new BadRequestException('Invalid requested document.');
    const key = `${d.documentType}:${d.subjectSlot || ''}`;
    if (seen.has(key))
      throw new BadRequestException(
        'The same document and subject cannot be selected twice.',
      );
    seen.add(key);
    return {
      documentType: d.documentType,
      ...(d.subjectSlot ? { subjectSlot: d.subjectSlot } : {}),
    };
  });
  const order = [
    'primary-monthly',
    'primary-evaluation',
    'primary-yellow-book',
    'kindergarten-art-monthly',
    'kindergarten-development',
  ];
  return documents.sort(
    (a, b) =>
      order.indexOf(a.documentType) - order.indexOf(b.documentType) ||
      (a.subjectSlot || '').localeCompare(b.subjectSlot || ''),
  );
}

export function resolveRequestedDocuments(
  options: any[],
  selections: RequestedDocument[],
) {
  return selections.map((selection) => {
    const document = options.find((d) => d.id === selection.documentType);
    const subject = document?.subjects?.find(
      (s: any) => s.id === selection.subjectSlot,
    );
    if (
      !document?.canRequest ||
      (document.id === 'primary-evaluation'
        ? !subject
        : Boolean(selection.subjectSlot))
    )
      throw new ConflictException(
        'A requested document or subject is not available for this student.',
      );
    return {
      documentType: document.id,
      documentLabel: document.label,
      documentLabelLo: document.labelLo,
      ...(document.sourceReportId
        ? {
            sourceReportId: document.sourceReportId,
            sourceVersion: document.sourceVersion,
            templateVersion: document.templateVersion,
          }
        : {}),
      ...(subject
        ? {
            subjectSlot: subject.id,
            subjectId: subject.subjectId,
            subjectName: subject.label,
          }
        : {}),
    };
  });
}
