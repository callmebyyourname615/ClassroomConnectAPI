"""Render the reviewed local exam plan with embedded Lao fonts using Chromium."""
import base64, html, json, pathlib, sys
from playwright.sync_api import sync_playwright

plan = json.loads(pathlib.Path(sys.argv[1]).read_text())
backend = pathlib.Path(__file__).resolve().parents[1]
font = backend.parent / 'Admin_Panel_Alpha_sundaynewmerge/public/fonts/NotoSansLao_SemiCondensed-Regular.ttf'
font_data = base64.b64encode(font.read_bytes()).decode()
style = f'''@font-face{{font-family:Lao;src:url(data:font/ttf;base64,{font_data})}}body{{font-family:Lao,sans-serif;font-size:16px;color:#111}}h1{{font-size:22px;text-align:center;margin:0 0 8px}}h2{{font-size:17px;text-align:center;margin:0 0 14px}}.meta{{line-height:1.8;border-bottom:1px solid #aaa;padding-bottom:10px}}ol{{padding-left:28px}}li{{margin:14px 0;break-inside:avoid}}.answer{{color:#111;font-weight:bold;margin-left:10px}}footer{{margin-top:24px;font-size:12px;color:#555}}'''
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    for exam in plan['exams']:
        for answer_key, field in [(False, 'examFile'), (True, 'answerFile')]:
            path = backend / exam[field]
            path.parent.mkdir(parents=True, exist_ok=True)
            items = ''.join(f'<li>{html.escape(q["prompt"])}' + (f'<span class="answer">ຄຳຕອບ: {html.escape(q["answer"])}</span>' if answer_key else '<div>ຄຳຕອບ: ........................................................................</div>') + '</li>' for q in exam['questions'])
            page.set_content(f'<html lang="lo"><meta charset="utf-8"><style>{style}</style><h1>{"ແນວຄຳຕອບ" if answer_key else "ຂໍ້ສອບຄະນິດສາດ"}</h1><h2>{html.escape(exam["title"])}</h2><div class="meta">ສົກຮຽນ: {plan["academicYearLabel"]} · ຫ້ອງ: {html.escape(exam["className"])}<br>10 ຂໍ້ · ຂໍ້ລະ 1 ຄະແນນ · ຄະແນນເຕັມ 10 · ເວລາ {exam["durationMinutes"]} ນາທີ<br>ຊື່ ແລະ ນາມສະກຸນ: ................................................................</div><ol>{items}</ol><footer>ຂໍ້ສອບຕົວຢ່າງສຳລັບ ClassroomConnect · ໃຫ້ຄະແນນ 1 ເມື່ອຄຳຕອບຖືກຕ້ອງ</footer></html>')
            page.evaluate('document.fonts.ready')
            page.pdf(path=str(path), format='A4', margin={k:'12mm' for k in ['top','bottom','left','right']}, print_background=True)
    browser.close()
print(f'Rendered {len(plan["exams"]) * 2} Lao exam/answer PDFs', flush=True)
