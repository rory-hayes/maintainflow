"""Deterministic synthetic PDF authoring only; never reads the expected manifest.

Requires existing ReportLab, Pillow, pypdf and pdftoppm. No application imports,
provider calls, credentials or new dependencies. Run from any working directory.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageOps
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
SIZE = landscape(A4)
WIDTH, HEIGHT = SIZE
INK = colors.HexColor('#17283B')
MUTED = colors.HexColor('#536476')
PALE = colors.HexColor('#EDF3F7')
LINE = colors.HexColor('#CAD5DD')
LEFT = 42
RIGHT = WIDTH - LEFT


def pdf(name, title):
    document = canvas.Canvas(str(ROOT / name), pagesize=SIZE, invariant=1, pageCompression=1)
    document.setTitle(title)
    document.setAuthor('MaintainFlow synthetic acceptance fixtures')
    document.setSubject('Synthetic test document. Not a real bank or account.')
    return document


def text(c, value, x, y, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', size)
    c.drawString(x, y, value)


def wrap(value, width, font='Helvetica', size=9.3):
    lines = []
    for paragraph in value.split('\n'):
        words = paragraph.split()
        line = ''
        for word in words:
            candidate = (line + ' ' + word).strip()
            if stringWidth(candidate, font, size) > width and line:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
    return lines


def header(c, case, title, subtitle, page, total):
    c.setFillColor(INK)
    c.rect(0, HEIGHT - 29, WIDTH, 29, fill=1, stroke=0)
    text(c, 'SYNTHETIC TEST DOCUMENT - NOT A REAL BANK OR ACCOUNT', LEFT, HEIGHT - 19, 9, True, colors.white)
    text(c, title, LEFT, 532, 23, True)
    text(c, subtitle, LEFT, 510, 11, False, MUTED)
    c.setStrokeColor(LINE)
    c.line(LEFT, 497, RIGHT, 497)
    text(c, f'{case} | Synthetic acceptance source', LEFT, 24, 8, False, MUTED)
    text(c, f'Page {page} of {total}', RIGHT - 56, 24, 8, False, MUTED)


def info(c, bank, account, currency, opening, dates, notes):
    text(c, f'Bank: {bank}', LEFT, 477, 10, True)
    text(c, f'Account: {account}    Currency: {currency}', LEFT, 459, 10)
    text(c, f'Statement period: {dates}', LEFT, 441, 10)
    text(c, f'Opening balance: {opening}', RIGHT - 218, 477, 10, True)
    for index, note in enumerate(notes):
        text(c, note, LEFT, 422 - 15 * index, 9, False, MUTED)


def table(c, top, headings, widths, rows):
    c.setFillColor(PALE)
    c.rect(LEFT, top - 25, sum(widths), 25, fill=1, stroke=0)
    x = LEFT
    for heading, width in zip(headings, widths):
        text(c, heading, x + 6, top - 16, 8.7, True)
        x += width
    y = top - 25
    for row in rows:
        blocks = [wrap(value, width - 12) for value, width in zip(row, widths)]
        height = max(38, 15 + max(len(lines) for lines in blocks) * 12)
        x = LEFT
        for col, (lines, width) in enumerate(zip(blocks, widths)):
            for line_no, line in enumerate(lines):
                if col >= len(row) - 2:
                    c.setFillColor(INK)
                    c.setFont('Helvetica', 9.3)
                    c.drawRightString(x + width - 6, y - 16 - line_no * 12, line)
                else:
                    text(c, line, x + 6, y - 16 - line_no * 12, 9.3)
            x += width
        y -= height
        c.setStrokeColor(LINE)
        c.line(LEFT, y, RIGHT, y)
    assert y >= 92, f'Table overflow at {y}'
    return y


def summary(c, y, lines):
    y -= 23
    for line in lines:
        text(c, line, LEFT, y, 10, True)
        y -= 18
    assert y >= 42, f'Summary overflow at {y}'


def case_a():
    c = pdf('case-a-eur-multipage-native.pdf', 'Synthetic case A - European current account')
    columns = ['Item', 'Date', 'Description', 'Reference', 'Debit EUR', 'Credit EUR', 'Balance EUR']
    widths = [29, 66, 231, 78, 82, 82, RIGHT - LEFT - 568]
    # Source values are authored literally. The expected manifest is a separate file.
    first = [
        ['01', '02/08/2026', 'Workshop materials\nAugust repair and maintenance supplies', 'A-1001', '125,50', '', '2.374,50'],
        ['02', '03/08/2026', 'Customer settlement\nInvoice INV-2048, installation project', 'A-1002', '', '1.200,00', '3.574,50'],
        ['03', '05/08/2026', 'Equipment rental daily charge', 'RENT-DAILY', '49,95', '', '3.524,55'],
        ['04', '05/08/2026', 'Equipment rental daily charge', 'RENT-DAILY', '49,95', '', '3.474,60'],
        ['05', '12/08/2026', 'Premises cleaning\nQuarterly deep-clean service', 'A-1005', '320,00', '', '3.154,60'],
        ['06', '15/08/2026', 'Credit interest', 'A-1006', '', '0,40', '3.155,00'],
    ]
    second = [
        ['07', '19/08/2026', 'Equipment servicing\nReplacement filter, fitting and inspection', 'A-1007', '1.050,75', '', '2.104,25'],
        ['08', '20/08/2026', 'Supplier refund\nReturned unused component', 'A-1008', '', '275,25', '2.379,50'],
        ['09', '28/08/2026', 'Account service fee', 'A-1009', '12,00', '', '2.367,50'],
        ['10', '31/08/2026', 'Office consumables', 'A-1010', '99,99', '', '2.267,51'],
    ]
    for page, rows in [(1, first), (2, second)]:
        header(c, 'MF-HO-A', 'European current account', 'Example Delta Bank - synthetic institution', page, 2)
        info(c, 'Example Delta Bank', 'TEST-EUR-286', 'EUR', '2.500,00 EUR', '01/08/2026 to 31/08/2026', [
            'Dates use DD/MM/YYYY. Amounts use a decimal comma and a full stop for thousands.',
            'Credits increase and debits decrease the account balance. Blank amount cells mean no entry.',
        ])
        bottom = table(c, 386, columns, widths, rows)
        if page == 1:
            summary(c, bottom, ['Carried forward: 3.155,00 EUR. Transactions continue on page 2.'])
        else:
            summary(c, bottom, ['Total debits: 1.708,14 EUR    Total credits: 1.475,65 EUR', 'Closing balance on 31/08/2026: 2.267,51 EUR', 'Items 03 and 04 are separately listed transactions. No transactions have been removed.'])
        c.showPage()
    c.save()


def case_b():
    c = pdf('case-b-multiple-accounts-native.pdf', 'Synthetic case B - separate USD and EUR accounts')
    columns = ['Item', 'Date', 'Description', 'Reference', 'Signed amount', 'Running balance']
    widths = [29, 74, 269, 105, 127, RIGHT - LEFT - 604]
    groups = [
        ('USD', 'TEST-USD-041', 'Not provided', [
            ['U1', '2026-09-04', 'Incoming customer payment\nSeptember workshop reservation', 'USD-901', '+3,450.75', '4,250.75'],
            ['U2', '2026-09-10', 'Cloud hosting\nSeptember service period', 'USD-902', '-120.50', ''],
            ['U3', '2026-09-14', 'Office supplies', 'USD-903', '(30.25)', '4,100.00'],
            ['U4', '2026-09-29', 'Transfer to reserve', 'USD-904', '-600.00', '3,500.00'],
        ], ['Statement total debits: 750.70 USD    Statement total credits: 3,450.75 USD', 'Closing balance: 3,500.00 USD', 'The opening balance and the running balance for item U2 are not supplied.']),
        ('EUR', 'TEST-EUR-057', '1,250.00 EUR', [
            ['E1', '2026-09-03', 'Service payment received', 'EUR-901', '+1,000.00', '2,250.00'],
            ['E2', '2026-09-06', 'Workshop lease adjustment', 'EUR-902', '(250.25)', '1,999.75'],
            ['E3', '2026-09-17', 'Telephone and data service', 'EUR-903', '-75.10', '1,924.65'],
            ['E4', '2026-09-30', 'Returned payment fee refund', 'EUR-904', '+25.35', '1,950.00'],
        ], ['Statement total debits: 325.35 EUR    Statement total credits: 1,025.35 EUR', 'Closing balance: 1,950.00 EUR', 'Each account has separate totals. No combined balance or currency conversion is supplied.']),
    ]
    for page, (currency, account, opening, rows, totals) in enumerate(groups, 1):
        header(c, 'MF-HO-B', 'Separate currency accounts', 'Example Harbour Bank - synthetic institution', page, 2)
        info(c, 'Example Harbour Bank', account, currency, opening, '2026-09-01 to 2026-09-30', [
            f'Only {currency} amounts appear on this page. Dates use YYYY-MM-DD; amounts use a decimal point.',
            'A plus sign is a credit. A minus sign or parentheses is a debit. Credits increase the balance.',
        ])
        bottom = table(c, 386, columns, widths, rows)
        summary(c, bottom, totals)
        c.showPage()
    c.save()


def render(source, destination):
    subprocess.run(['pdftoppm', '-png', '-r', '144', str(source), str(destination)], check=True, capture_output=True)
    return sorted(destination.parent.glob(destination.name + '-*.png'))


def main():
    case_a()
    case_b()
    with tempfile.TemporaryDirectory(prefix='maintainflow-held-out-pdf-') as temporary:
        temporary = Path(temporary)
        source_images = render(ROOT / 'case-a-eur-multipage-native.pdf', temporary / 'case-a-native')
        scan = pdf('case-a-eur-multipage-raster.pdf', 'Synthetic case A - image-only derivative, not an independent case')
        for image_path in source_images:
            with Image.open(image_path) as image:
                grayscale = ImageOps.grayscale(image)
                scan.drawImage(ImageReader(grayscale), 0, 0, width=WIDTH, height=HEIGHT)
            scan.showPage()
        scan.save()
        pages = []
        reports = []
        for name in ['case-a-eur-multipage-native.pdf', 'case-b-multiple-accounts-native.pdf', 'case-a-eur-multipage-raster.pdf']:
            source = ROOT / name
            reader = PdfReader(source)
            images = render(source, temporary / source.stem)
            reports.append({'file': name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'bytes': source.stat().st_size, 'pages': len(reader.pages), 'textCharactersPerPage': [len(page.extract_text() or '') for page in reader.pages], 'embeddedImagesPerPage': [len(page.images) for page in reader.pages], 'renderedPages': len(images)})
            for number, image_path in enumerate(images, 1):
                with Image.open(image_path) as image:
                    pages.append((f'{name} - page {number}', image.copy()))
        assert all(report['pages'] == 2 and report['renderedPages'] == 2 for report in reports)
        assert all(count > 100 for report in reports[:2] for count in report['textCharactersPerPage'])
        assert reports[2]['textCharactersPerPage'] == [0, 0]
        assert reports[2]['embeddedImagesPerPage'] == [1, 1]
        (ROOT / 'offline-structure-checks.json').write_text(json.dumps({'kind': 'offline_pdf_structure_only', 'providerCalls': 0, 'independentCases': 2, 'derivedRenditions': 1, 'renderDpi': 144, 'files': reports}, indent=2) + '\n')
        # Contact sheet is a review aid. Individual page PNGs are temporary.
        from PIL import ImageDraw
        preview = Image.new('RGB', (1700, 1944), 'white')
        draw = ImageDraw.Draw(preview)
        for index, (label, image) in enumerate(pages):
            x, y = (index % 2) * 850, (index // 2) * 648
            draw.text((x + 12, y + 12), label, fill='black')
            image.thumbnail((830, 608))
            preview.paste(image, (x + 10, y + 32))
        preview.save(ROOT / 'preview-contact-sheet.jpg', quality=90, optimize=True)
    print('Created 2 synthetic source cases and 1 image-only derivative; no extraction was executed.')


if __name__ == '__main__':
    main()
