#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Convierte los dos export de SoftRestaurant11 en los archivos de semilla de EV2.

    python3 scripts/import-sr11-catalog.py productos.xls recetas.xls

Escribe (o reescribe) tres archivos en `seeds/data/`:

    ev2-menu.json      la carta que se vende, con el precio unificado entre barras
    ev2-supplies.json  los insumos del almacen, con su presentacion y unidad base
    ev2-recipes.json   cuanto de cada insumo consume una unidad de cada producto

Se necesita `xlrd` (pip install xlrd) porque los export vienen en el .xls viejo de
Excel 97. Es una herramienta de captura, no parte del servidor: se corre cuando el
club vuelve a exportar su catalogo, y su salida (los tres JSON) es lo que se
versiona y lo que leen las semillas.

Las reglas de conversion, todas discutidas con el dueno, y por que:

1.  UNA ONZA SON 30 ML. Es la medida con la que sirve la barra, no la onza exacta
    de 29.5735. Con la onza exacta, vender una botella de 750 ml "de 25 oz" dejaria
    10 ml fantasma en el inventario para siempre; con 30 ml la botella entera sale
    en cero, que es lo que de verdad pasa.

2.  EL TAMANO DE LA PRESENTACION SALE DEL NOMBRE DEL INSUMO. SoftRestaurant lo
    declara ahi mismo: `VODKA ABSOLUT - (750 ML)`, `TRIPLE SEC - (1L - 33 OZ)`,
    `MONSTER - (473 ML - 16 OZ)`. Cuando el nombre solo declara onzas
    (`DON JULIO 70 - (23 OZ)`), se convierten con la regla 1.

3.  SI NO LO DECLARA, SE INFIERE DE LA PROPIA RECETA. Un producto del grupo
    BOTELLAS que consume "33 OZ" de un insumo esta vendiendo la botella completa,
    asi que esa cantidad ES la presentacion. Es un dato del club, no una suposicion
    nuestra.

4.  Y SI TAMPOCO, SE MARCA. Las botellas que solo se venden enteras (`1 BOTE`) no
    dicen su tamano en ningun lado. Se cargan con 750 ml y `size_confirmed: false`,
    y la pantalla de almacen las pide confirmar antes del primer conteo. Inventar
    un numero y callarlo es como se arruina un inventario.

5.  LA CERVEZA SE CUENTA POR BOTELLA. Las unidades `CUAR` (la cuarta de 325 ml) y
    `MEDI` (la media de 355 ml) son piezas, no volumen: nadie sirve media cerveza.
    Una cubeta de `10 CUAR` descuenta 10 botellas.

6.  LAS BARRAS COMPARTEN CATALOGO Y PRECIO, Y EL PRECIO ES EL MAYOR. El export
    trae cada producto hasta tres veces (grupo normal, ` B2` y ` B3`, una copia por
    barra) y en seis casos con precios distintos -- `CAPITAN MORGAN - COCA COLA` a
    $120 en una barra y a $240 en otra. Cobrar distinto segun quien sirva es un
    problema con el cliente, no una funcion; se toma el precio mas alto, que es la
    regla que dio el dueno.

7.  `precio` DE SOFTRESTAURANT YA TRAE EL IVA. Verificado contra su propia columna
    `preciosinimpuestos`: 220.00 con impuestos, 203.70 sin ellos, IVA del 8% de la
    franja fronteriza. Se carga el precio con IVA porque es el que ve y paga el
    cliente.
"""

import json
import os
import re
import sys
import unicodedata
from collections import OrderedDict, defaultdict

try:
    import xlrd
except ImportError:  # pragma: no cover - herramienta de captura
    sys.exit('Falta xlrd. Instalalo con: pip install xlrd')

OZ_TO_ML = 30.0
DEFAULT_BOTTLE_ML = 750.0
TAX_RATE_PCT = 8

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'seeds', 'data')

# Los grupos del POS que son barra. El resto (COVER, VIP, PAQUETES, SERVICIOS de
# puerta) se cobra en otra parte del sistema y no va en la carta de la barra.
MENU_GROUPS = {
    'DRINKS': 'Drinks',
    'BOTELLAS': 'Botellas',
    'SHOTS': 'Shots',
    'CERVEZAS': 'Cervezas',
    'SERVICIOS': 'Sin alcohol',
}

# Lo que no es carta de barra pero si se vende con una reservacion. El codigo es el
# que usa la app (`reservations.js` lo espera por nombre), asi que se fija aqui y no
# se deriva del nombre: si manana la caja renombra el producto, el codigo aguanta.
RESERVATION_ADDONS = {
    '10058': ('vip_wristband', 'Pulsera extra VIP'),
    '16001': ('birthday_package', 'Paquete cumpleañero'),
    '16002': ('birthday_package_premium', 'Paquete cumpleañero premium'),
}

# Los covers de la puerta, de referencia: los cobra la anfitriona, no la barra.
COVER_IDS = ('06002', '06005', '06013')

# Palabra con la que empieza el insumo -> categoria de almacen. El orden importa:
# se toma la primera que coincida.
SUPPLY_CATEGORIES = [
    (('TEQUILA', 'MEZCAL'), 'Tequila y mezcal'),
    (('WHISKY', 'WHISKEY'), 'Whisky'),
    (('VODKA',), 'Vodka'),
    (('RON',), 'Ron'),
    (('GINEBRA',), 'Ginebra'),
    (('VINO',), 'Vino y espumoso'),
    (('LICOR', 'CONCENTRADO', 'ALMIBAR', 'CREMA', 'CARNATION', 'CALAHUA'), 'Licores y jarabes'),
    (('JUGO', 'NARANJADA', 'CLAMATO'), 'Jugos'),
    (('TECATE', 'ULTRA', 'CAGUAMA', 'BOTE TECATE', 'MILLER'), 'Cerveza'),
    (('MONSTER', 'POWERADE', 'FOUR', 'CARIBE', 'TWISTED', 'BUZZBALL', 'SKY'), 'Preparados y energeticas'),
    (('AGUA', 'SPRITE', 'COCA', 'SQUIRT', 'FRESCA', 'REFRESCO'), 'Refrescos y agua'),
    (('LIMON', 'PINA', 'GLITTER', 'HERSHEYS', 'PULSERA', 'YARDA', 'PETROLEO', 'VIP'), 'Otros'),
]


def strip_accents(text):
    return ''.join(c for c in unicodedata.normalize('NFD', text)
                   if unicodedata.category(c) != 'Mn')


def cell(row, index):
    """Texto de una celda, sin el apostrofo con el que Excel marca texto."""
    return str(row[index].value).lstrip("'").strip()


def read_sheet(path):
    book = xlrd.open_workbook(path)
    sheet = book.sheet_by_index(0)
    header = [str(c.value).strip() for c in sheet.row(0)]
    index = {name: i for i, name in enumerate(header)}
    rows = [sheet.row(r) for r in range(1, sheet.nrows)]
    return index, rows


# ---------------------------------------------------------------------------
# productos.xls
# ---------------------------------------------------------------------------

def load_products(path):
    ix, rows = read_sheet(path)
    products = []
    for row in rows:
        pos_id = cell(row, ix['idproducto'])
        if not pos_id:
            continue
        products.append({
            'pos_id': pos_id,
            'name': cell(row, ix['descripcion']),
            'group': cell(row, ix['grupodescripcion']),
            # `precio` ya trae el IVA (ver regla 7 del encabezado).
            'price': float(row[ix['precio']].value or 0),
            'price_no_tax': float(row[ix['preciosinimpuestos']].value or 0),
            'blocked': cell(row, ix['bloqueado']) == '1',
        })
    return products


def bar_group(group):
    """`DRINKS B2` -> `DRINKS`. Las tres barras son el mismo catalogo."""
    return re.sub(r'\s+B[23]$', '', group).strip()


def family_key(name, group):
    """Identidad de un producto entre barras: mismo nombre y mismo grupo base."""
    clean = re.sub(r'\s+B[23]\b', '', name)
    clean = re.sub(r'[^A-Z0-9]', '', strip_accents(clean).upper())
    return (clean, bar_group(group))


def build_menu(products):
    """La carta: un renglon por producto, con el precio mas alto entre barras."""
    families = defaultdict(list)
    for p in products:
        if p['group'] == 'SUSPENDIDOS':
            continue
        families[family_key(p['name'], p['group'])].append(p)

    items = []
    unified = []
    for key, family in sorted(families.items()):
        base = bar_group(family[0]['group'])
        if base not in MENU_GROUPS:
            continue
        # El renglon de la barra principal es el que manda el nombre y el pos_id:
        # es el que la caja usa hoy y con el que ya sincroniza la app.
        primary = next((p for p in family if p['group'] == base), family[0])
        if primary['blocked'] or primary['price'] <= 0:
            continue
        best = max(p['price'] for p in family)
        if abs(best - primary['price']) > 0.005:
            unified.append({
                'name': primary['name'],
                'from': round(primary['price'], 2),
                'to': round(best, 2),
                'bars': sorted({(p['group'], round(p['price'], 2)) for p in family}),
            })
        items.append(OrderedDict([
            ('pos_id', primary['pos_id']),
            ('name', primary['name']),
            ('category', MENU_GROUPS[base]),
            ('price', round(best, 2)),
            ('pos_group', base),
            # Los pos_id de las copias B2/B3: la sincronizacion con la caja los
            # necesita para reconocer una venta hecha en cualquiera de las barras.
            ('pos_id_aliases', sorted(p['pos_id'] for p in family if p['pos_id'] != primary['pos_id'])),
        ]))
    items.sort(key=lambda i: (i['category'], i['name']))

    # Las botellas de la carta se venden tambien con la mesa, al mismo precio: una
    # botella que cuesta distinto segun como se pida es una discusion con el cliente
    # esperando a ocurrir, asi que sale de la misma lista y no de una capturada aparte.
    bottles = [OrderedDict([
        ('code', f"pos-{item['pos_id']}"),
        ('name', item['name']),
        ('price', item['price']),
        ('pos_id', item['pos_id']),
    ]) for item in items if item['category'] == 'Botellas']

    by_pos = {p['pos_id']: p for p in products}
    price_of = {}
    for key, family in families.items():
        best = max(p['price'] for p in family)
        for member in family:
            price_of[member['pos_id']] = best

    addons = []
    for pos_id, (code, label) in RESERVATION_ADDONS.items():
        product = by_pos.get(pos_id)
        if product is None:
            continue
        addons.append(OrderedDict([
            ('code', code),
            ('name', label),
            ('price', round(price_of.get(pos_id, product['price']), 2)),
            ('pos_id', pos_id),
        ]))

    covers = []
    for pos_id in COVER_IDS:
        product = by_pos.get(pos_id)
        if product is None:
            continue
        covers.append(OrderedDict([
            ('name', product['name']),
            ('price', round(price_of.get(pos_id, product['price']), 2)),
            ('pos_id', pos_id),
        ]))
    covers.sort(key=lambda c: -c['price'])

    return items, unified, bottles, addons, covers


# ---------------------------------------------------------------------------
# recetas.xls
# ---------------------------------------------------------------------------

def load_recipes(path):
    """
    El export viene en bloques: un renglon con el producto y debajo un renglon por
    ingrediente (el producto queda vacio). Se recorre en orden y se va colgando
    cada ingrediente del ultimo producto visto.
    """
    ix, rows = read_sheet(path)
    recipes = OrderedDict()
    current = None
    for row in rows:
        pos_id = cell(row, ix['idproducto'])
        if pos_id:
            current = {
                'pos_id': pos_id,
                'name': cell(row, ix['descripcionproducto']),
                'group': cell(row, ix['descripciongrupo']),
                'lines': [],
            }
            recipes.setdefault(pos_id, current)
            current = recipes[pos_id]
            continue
        supply_id = cell(row, ix['idinsumo'])
        if not supply_id or current is None:
            continue
        quantity = float(row[ix['cantidad']].value or 0)
        if quantity <= 0:
            continue
        current['lines'].append({
            'supply_pos_id': supply_id,
            'supply_name': cell(row, ix['descripcioninsumo']),
            'quantity': quantity,
            'unit': cell(row, ix['unidad']),
        })
    return recipes


def declared_package(name):
    """
    Presentacion declarada en el nombre del insumo. Devuelve (ml, de_donde).

    Se busca primero el volumen en mililitros o litros; si solo hay onzas, se
    convierten con la regla del club (1 oz = 30 ml).
    """
    upper = strip_accents(name).upper()
    match = re.search(r'(\d+(?:[.,]\d+)?)\s*L\b', upper)
    if match:
        return float(match.group(1).replace(',', '.')) * 1000.0, 'declared'
    match = re.search(r'(\d+(?:[.,]\d+)?)\s*ML\b', upper)
    if match:
        return float(match.group(1).replace(',', '.')), 'declared'
    match = re.search(r'(\d+(?:[.,]\d+)?)\s*GR\b', upper)
    if match:
        return float(match.group(1).replace(',', '.')), 'declared'
    match = re.search(r'(\d+(?:[.,]\d+)?)\s*0?Z\b', upper)
    if match:
        return float(match.group(1).replace(',', '.')) * OZ_TO_ML, 'declared_oz'
    return None, None


def clean_supply_name(name):
    """
    `VODKA ABSOLUT - (750 ML)` -> `VODKA ABSOLUT`. El tamano se guarda aparte, en
    `package_size`, para que la pantalla pueda decir "3.5 botellas de 750 ml" en
    vez de repetir el parentesis en cada renglon.
    """
    # Solo se quita el parentesis cuando es UN TAMANO y nada mas. `TEQUILA (CABRITOS,
    # HERENCIA ORO - 33 OZ)` y `MEZCAL 400 CONEJOS (JOVEN)` llevan dentro lo unico que
    # los distingue: quitarlo dejaria un insumo llamado "TEQUILA" a secas, que en un
    # estante con doce tequilas no le dice nada a nadie.
    def only_size(match):
        inside = strip_accents(match.group(1)).upper()
        return '' if re.fullmatch(r'[\d\s.,/+-]*(?:ML|L|GR|OZ|0Z)[\dA-Z\s.,/+-]*', inside) else match.group(0)

    clean = re.sub(r'\s*-?\s*\(([^)]*)\)\s*$', only_size, name).strip()
    clean = re.sub(r'\s*-\s*(SUSPENDIDOS?|SUSPENDIDO)\s*$', '', clean, flags=re.I).strip()
    clean = re.sub(r'\s*\(SUSPENDIDOS?\)\s*$', '', clean, flags=re.I).strip()
    clean = re.sub(r'\s*-\s*$', '', clean).strip()
    return clean or name.strip()


def size_suffix(pos_name):
    """El tamano tal como lo escribe la caja: `(2L - 66 OZ)` -> `2 L`, `(355 ML)` -> `355 ML`."""
    upper = strip_accents(pos_name).upper()
    match = re.search(r'\(\s*(\d+(?:[.,]\d+)?)\s*(ML|L|GR|OZ)\b', upper)
    if match:
        return f'{match.group(1)} {match.group(2)}'
    return ''


def supply_category(name):
    upper = strip_accents(name).upper()
    for prefixes, label in SUPPLY_CATEGORIES:
        for prefix in prefixes:
            if upper.startswith(prefix):
                return label
    return 'Otros'


def base_unit(pos_unit):
    """La unidad del export -> la unidad base con la que vive la existencia."""
    if pos_unit == 'OZ':
        return 'ml'
    if pos_unit == 'BOTE':
        return 'ml'
    if pos_unit == 'KGS':
        return 'g'
    # PZA, CUAR (la cuarta) y MEDI (la media) son piezas: nadie sirve media cerveza.
    return 'pza'


def package_label(unit, size, pos_unit, pos_name):
    if unit == 'pza':
        if pos_unit == 'CUAR':
            return 'botella 1/4 (325 ml)'
        if pos_unit == 'MEDI':
            return 'botella media (355 ml)'
        return 'pieza'
    if unit == 'g':
        return f'{size:g} g'
    if size >= 1000 and size % 1000 == 0:
        return f'botella {size / 1000:g} L'
    return f'botella {size:g} ml'


def build_supplies_and_recipes(menu_items, recipes):
    """
    Los insumos y las recetas de lo que de verdad se vende.

    Solo se cargan los insumos que aparecen en la receta de algun producto de la
    carta. Un insumo que no toca ningun producto no se descuenta nunca y solo
    ensuciaria el conteo fisico.
    """
    by_pos = {item['pos_id']: item for item in menu_items}
    # Las copias B2/B3 comparten receta, pero el producto de la app es uno solo:
    # se toma la receta del renglon principal y, si no la trae, la de una copia.
    alias_to_primary = {}
    for item in menu_items:
        for alias in item['pos_id_aliases']:
            alias_to_primary[alias] = item['pos_id']

    chosen = {}
    for pos_id, recipe in recipes.items():
        if not recipe['lines']:
            continue
        primary = pos_id if pos_id in by_pos else alias_to_primary.get(pos_id)
        if primary is None or primary in chosen:
            continue
        chosen[primary] = recipe

    # Paso 1: reunir cada insumo con todas las cantidades que le piden, para poder
    # inferir la presentacion de la receta que vende la botella completa (regla 3).
    seen = OrderedDict()
    for primary, recipe in chosen.items():
        for line in recipe['lines']:
            key = line['supply_pos_id']
            entry = seen.setdefault(key, {
                'pos_id': key,
                'pos_name': line['supply_name'],
                'pos_units': set(),
                'max_whole': 0.0,
                'max_any': 0.0,
            })
            entry['pos_units'].add(line['unit'])
            entry['max_any'] = max(entry['max_any'], line['quantity'])
            if by_pos[primary]['category'] == 'Botellas':
                entry['max_whole'] = max(entry['max_whole'], line['quantity'])

    supplies = []
    for entry in seen.values():
        if len(entry['pos_units']) != 1:
            raise SystemExit(
                f"El insumo {entry['pos_id']} ({entry['pos_name']}) llega con dos unidades "
                f"distintas ({sorted(entry['pos_units'])}). Eso hay que resolverlo en la "
                'caja antes de cargarlo: una existencia con dos unidades no se puede sumar.')
        pos_unit = next(iter(entry['pos_units']))
        unit = base_unit(pos_unit)
        name = clean_supply_name(entry['pos_name'])

        if unit == 'pza':
            size, source = 1.0, 'piece'
        else:
            size, source = declared_package(entry['pos_name'])
            if size is None and entry['max_whole'] > 0 and pos_unit == 'OZ':
                # La receta que vende la botella entera dice cuanto trae la botella.
                size, source = entry['max_whole'] * OZ_TO_ML, 'inferred_from_recipe'
            if size is None:
                size, source = DEFAULT_BOTTLE_ML, 'default'

        supplies.append(OrderedDict([
            ('pos_id', entry['pos_id']),
            ('name', name),
            ('pos_name', entry['pos_name']),
            ('category', supply_category(entry['pos_name'])),
            ('unit', unit),
            ('package_size', round(size, 3)),
            ('package_label', package_label(unit, size, pos_unit, entry['pos_name'])),
            ('pos_unit', pos_unit),
            # false = nadie ha confirmado el tamano de la botella. La pantalla de
            # almacen lo pide antes del primer conteo en vez de fingir que lo sabe.
            ('size_confirmed', source != 'default'),
            ('size_source', source),
        ]))
    # Dos insumos DISTINTOS pueden quedarse con el mismo nombre al quitarles el
    # parentesis: `AGUA MINERAL - (2L)` y `AGUA MINERAL - (355 ML)` son la botella
    # grande de la barra y la lata que se sirve tal cual. Se les devuelve el tamano al
    # nombre, porque en la bodega son dos estantes distintos y en la pantalla tienen
    # que poder distinguirse de un vistazo.
    counts = defaultdict(int)
    for supply in supplies:
        counts[supply['name'].upper()] += 1
    for supply in supplies:
        if counts[supply['name'].upper()] > 1:
            supply['name'] = f"{supply['name']} {size_suffix(supply['pos_name'])}".strip()

    supplies.sort(key=lambda s: (s['category'], s['name']))
    size_by_pos = {s['pos_id']: s for s in supplies}

    recipe_items = []
    for primary, recipe in chosen.items():
        lines = []
        for line in recipe['lines']:
            supply = size_by_pos[line['supply_pos_id']]
            qty = line['quantity']
            if supply['unit'] == 'pza':
                converted = qty
            elif line['unit'] == 'OZ':
                converted = qty * OZ_TO_ML
            elif line['unit'] == 'BOTE':
                converted = qty * supply['package_size']
            elif line['unit'] == 'KGS':
                converted = qty * 1000.0
            else:
                converted = qty
            # "Casi la botella entera" es la botella entera: `33 OZ` de un litro son
            # 990 ml con la onza de 30, y dejar 10 ml en el estante cada vez que se
            # vende una botella es como el inventario se llena de sobras que no
            # existen. Se ajusta solo cuando la receta ya pedia casi todo (95%).
            package = supply['package_size']
            if supply['unit'] != 'pza' and package > 0:
                whole = round(converted / package)
                if whole >= 1 and abs(converted - whole * package) / package <= 0.05:
                    converted = whole * package
            lines.append(OrderedDict([
                ('supply_pos_id', line['supply_pos_id']),
                ('supply_name', supply['name']),
                ('quantity', round(converted, 3)),
                ('unit', supply['unit']),
                ('pos_quantity', qty),
                ('pos_unit', line['unit']),
            ]))
        lines.sort(key=lambda l: l['supply_name'])
        recipe_items.append(OrderedDict([
            ('pos_id', primary),
            ('name', by_pos[primary]['name']),
            ('category', by_pos[primary]['category']),
            ('lines', lines),
        ]))
    recipe_items.sort(key=lambda r: (r['category'], r['name']))
    return supplies, recipe_items


def write_json(filename, payload):
    path = os.path.normpath(os.path.join(DATA_DIR, filename))
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    return path


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    products_path, recipes_path = argv[1], argv[2]
    exported_on = os.environ.get('EXPORT_DATE', '2026-09-14')

    products = load_products(products_path)
    menu_items, unified, bottles, addons, covers = build_menu(products)
    recipes = load_recipes(recipes_path)
    supplies, recipe_items = build_supplies_and_recipes(menu_items, recipes)

    write_json('ev2-menu.json', OrderedDict([
        ('$comment',
         'Catalogo real de EV2 Clandestinoz, exportado de SoftRestaurant11 (tabla productos) '
         'y generado por scripts/import-sr11-catalog.py. Los precios YA INCLUYEN el IVA del 8% '
         'de la franja fronteriza (verificado contra la columna preciosinimpuestos del export), '
         'que es como se cobran en la caja. Las tres barras comparten catalogo y precio: donde '
         'las copias B2/B3 traian precios distintos se carga EL MAYOR, y los pos_id de las '
         'copias quedan en pos_id_aliases para que la sincronizacion reconozca una venta hecha '
         'en cualquier barra. Se excluyen los SUSPENDIDOS, lo bloqueado en la caja, lo de precio '
         'cero (cortesias) y los grupos que no son barra (COVER, VIP, PAQUETES).'),
        ('version', 2),
        ('source', 'SoftRestaurant11 - productos.xls'),
        ('exported_on', exported_on),
        ('currency', 'MXN'),
        ('tax_included', True),
        ('tax_rate_pct', TAX_RATE_PCT),
        ('price_rule', 'max_across_bars'),
        ('unified_prices', unified),
        ('items', menu_items),
        ('reservation_bottles', bottles),
        ('reservation_addons', addons),
        ('cover_reference', covers),
    ]))

    write_json('ev2-supplies.json', OrderedDict([
        ('$comment',
         'Insumos del almacen, derivados de las recetas reales de SoftRestaurant11 por '
         'scripts/import-sr11-catalog.py. `unit` es la unidad base en la que viven la '
         'existencia, la receta y el costo: ml para liquido, g para solido, pza para lo que '
         'se cuenta por pieza (cerveza, lata, bote). `package_size` es cuanto de esa unidad '
         'trae una presentacion, para poder decir "quedan 3.5 botellas" en vez de "quedan '
         '2630 ml". Una onza son 30 ml, que es como sirve la barra. `size_confirmed: false` '
         'marca las botellas cuyo tamano no declara ni el nombre ni ninguna receta: se '
         'cargaron con 750 ml y hay que confirmarlas antes del primer conteo. NO se incluye '
         'existencia: entra por conteo fisico o por recepcion de mercancia, nunca de aqui.'),
        ('version', 1),
        ('source', 'SoftRestaurant11 - recetas.xls (insumos)'),
        ('exported_on', exported_on),
        ('oz_to_ml', OZ_TO_ML),
        ('default_bottle_ml', DEFAULT_BOTTLE_ML),
        ('items', supplies),
    ]))

    write_json('ev2-recipes.json', OrderedDict([
        ('$comment',
         'Receta de cada producto de la carta: cuanto de cada insumo consume UNA unidad, '
         'en la unidad base del insumo. Generado por scripts/import-sr11-catalog.py desde '
         'recetas.xls. `pos_quantity`/`pos_unit` conservan lo que dijo la caja, para poder '
         'auditar la conversion. Un producto que no aparece aqui no descuenta nada y se '
         'vende sin control de existencia, que es la verdad mientras no tenga receta.'),
        ('version', 1),
        ('source', 'SoftRestaurant11 - recetas.xls'),
        ('exported_on', exported_on),
        ('oz_to_ml', OZ_TO_ML),
        ('items', recipe_items),
    ]))

    pending = [s for s in supplies if not s['size_confirmed']]
    print(f'carta:    {len(menu_items)} productos ({len(unified)} con precio unificado al mayor)')
    print(f'insumos:  {len(supplies)} ({len(pending)} con tamano por confirmar)')
    print(f'recetas:  {len(recipe_items)} productos con receta')
    for item in unified:
        print(f"  precio unificado: {item['name']} {item['from']:.2f} -> {item['to']:.2f}")
    for supply in pending:
        print(f"  tamano por confirmar: {supply['name']} ({supply['pos_id']})")


if __name__ == '__main__':
    main(sys.argv)
