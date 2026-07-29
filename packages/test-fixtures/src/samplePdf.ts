/** 產生一份結構合法的最小 PDF（單頁、可被 pdf.js 解析），供 mock 檔案系統使用。 */
export function buildSamplePdf(lines: string[] = ['CozyPad mock PDF', 'Files workspace preview']): Uint8Array {
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 720 Td',
    ...lines.flatMap((line, index) => [
      index === 0 ? '' : '0 -32 Td',
      `(${line.replace(/([()\\])/g, '\\$1')}) Tj`,
    ]),
    'ET',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  return bytes;
}
