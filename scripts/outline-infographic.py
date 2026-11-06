"""Keep README typography independent of installed fonts or external SVG loads.

Requires fonttools and brotli; the editable SVG source remains alongside the output.
"""
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'infographic-fonts'))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
source = ROOT / 'docs' / 'images' / 'wallet-explainer-source.svg'
output = ROOT / 'docs' / 'images' / 'wallet-explainer.svg'
font = instantiateVariableFont(TTFont(ROOT / 'web' / 'fonts' / 'Outfit-Latin.woff2'), {'wght': 400})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
units = font['head'].unitsPerEm
tree = ET.parse(source)
root = tree.getroot()
rules = {
    'eyebrow': {'font-size': '15', 'letter-spacing': '2'},
    'body': {'font-size': '22'}, 'small': {'font-size': '18'},
    'number': {'font-size': '18', 'fill': '#aaa'},
    'heading': {'font-size': '32', 'letter-spacing': '-.6'},
    'muted': {'fill': '#c1c1c1'},
}
for parent in root.iter():
    for node in list(parent):
        if node.tag != f'{{{SVG}}}text':
            continue
        style = {'fill': '#fff', 'font-size': '18', 'letter-spacing': '0'}
        for name in node.get('class', '').split():
            style.update(rules.get(name, {}))
        style.update(node.attrib)
        size = float(style['font-size'])
        scale = size / units
        spacing = float(style['letter-spacing'])
        text = node.text or ''
        names = [cmap.get(ord(char), '.notdef') for char in text]
        advances = [glyphs[name].width * scale + spacing for name in names]
        width = sum(advances) - (spacing if advances else 0)
        x, y = float(node.get('x')), float(node.get('y'))
        if node.get('text-anchor') == 'end':
            x -= width
        group = ET.Element(f'{{{SVG}}}g', {'fill': style['fill'], 'aria-label': text})
        for name, advance in zip(names, advances):
            pen = SVGPathPen(glyphs)
            glyphs[name].draw(pen)
            path = pen.getCommands()
            if path:
                ET.SubElement(group, f'{{{SVG}}}path', {'d': path, 'transform': f'translate({x:.3f} {y:g}) scale({scale:g} {-scale:g})'})
            x += advance
        index = list(parent).index(node)
        parent.remove(node)
        parent.insert(index, group)
ET.indent(tree, space='  ')
tree.write(output, encoding='utf-8', xml_declaration=True)
print(f'Wrote {output.name} with Outfit outlines; editable source retained.')
