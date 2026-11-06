# BloomDesk v0.01

Aplicación local para catálogo de flores, fichas de productos, fincas, presentaciones, precios USA/UK y administración.

## Qué incluye

- Aplicación web local desarrollada con Python + Flask.
- Base de datos SQLite propia; no depende de Google Drive ni de FlowerpediaDB.
- Excel inicial: `data/current_week.xlsx` (copia local de `US_WEEK_45.xlsx`).
- Lectura de la tabla `Catalogo` por los nombres de los encabezados, no por el orden de las columnas.
- Lectura de dimensiones desde `Sheet1` → tabla `Cajas`.
- Lectura de fincas y estados desde `Fincas`.
- Lectura de listas auxiliares desde `Guias`: Category, Colors, Season y Size.
- Búsqueda, filtros por categoría/finca/color, tarjetas y ficha de producto.
- Composición y Tabla en apartados independientes.
- Dos colores independientes, temporada y tamaño.
- Tablas de precios y presentaciones USA / UK para personal autorizado.
- Mix Box Creator: intersección de fincas que tienen todas las variedades seleccionadas.
- Estado de llegada de fincas.
- Panel de administración para añadir/editar/eliminar registros.
- Pestañas independientes USA y UK en el formulario de administración.
- Cálculo de Markup según las fórmulas del Excel y modo inverso para sugerir precio desde un markup objetivo.
- Consulta y edición de dimensiones de cajas.
- Administración de usuarios y cambio de contraseñas.
- Importación de un nuevo Excel semanal y exportación del catálogo actualizado.
- Copia de seguridad del Excel anterior al importar una nueva semana.

## Requisitos

- Windows 10/11.
- Python 3.10 o superior.
- Conexión a internet la primera vez para instalar Flask y openpyxl.

## Cómo iniciar

1. Descomprime la carpeta `BloomDesk_v0.01`.
2. Abre la carpeta.
3. Haz doble clic en `start.bat`.
4. Se abrirá el navegador en `http://127.0.0.1:5000`.
5. En el primer inicio aparecerá un asistente para crear:
   - Usuario administrador.
   - Contraseña del administrador (mínimo 10 caracteres).
   - Contraseña de acceso al catálogo (mínimo 8 caracteres).

No hay una contraseña universal preinstalada. Tú creas las credenciales iniciales.

## Cómo añadir productos

1. Entra al catálogo y pulsa **Administrar**.
2. Abre **Añadir / editar**.
3. Completa los datos generales: Finca, Categoría, Producto, Composición, colores, Season, Tamaño, Tabla e IMG.
4. En la pestaña **USA** configura Caja EC, Caja Finca, Total Tallos, Compra y Venta o Markup objetivo.
5. En la pestaña **UK** configura Caja UK, Compra UK y Venta UK o Markup objetivo.
6. Pulsa **Guardar producto**.

El campo Total Tallos es compartido por las dos pestañas porque la fórmula UK también lo utiliza.

## Fórmulas aplicadas

### USA

- Volumen = Largo × Ancho × Alto / 6000.
- Para cajas distintas de SB, EB, QB, HB, EB2 y QB2, se añade el margen de seguridad de `Sheet1!U2` a cada dimensión.
- Transporte total = ROUNDUP(Volumen × 5.25 × 1.36, 2).
- Transporte por tallo = ROUNDUP(Transporte total / Total Tallos, 2).
- Duties = ROUNDUP(Compra × 0.1586, 2).
- Markup = `1 - ((Compra + Duties + Transporte por tallo) / (Venta × 0.96))`.

### UK

- Compra usada = Compra UK; si está vacía, se utiliza Compra.
- Compra convertida = Compra usada / 1.26.
- Volumen = Largo × Ancho × Alto / 6000.
- Transporte total = ROUNDUP(Volumen × 3.2 × 1.1, 2).
- Transporte por tallo = ROUNDUP(Transporte total / Total Tallos, 2).
- Coste total = ROUNDUP(Compra convertida + Transporte por tallo, 2).
- Markup UK = `1 - (Coste total / (Venta UK × 0.97))`.

Cuando se introduce un precio, BloomDesk calcula el markup resultante. Cuando se introduce un markup objetivo, calcula un precio sugerido redondeado hacia arriba a dos decimales y vuelve a calcular el porcentaje real a partir de ese precio.

Los parámetros de estas fórmulas se pueden revisar en **Excel y ajustes**. Los valores iniciales corresponden a WEEK_45.

## Cambiar de semana

1. Entra en **Administrar** → **Excel y ajustes**.
2. Selecciona el nuevo archivo `.xlsx`.
3. Pulsa **Importar Excel**.

El archivo debe contener:
- Hoja `Catalogo` con una tabla llamada `Catalogo` y las columnas obligatorias `Finca`, `Categoría` y `Producto`.
- Hoja `Sheet1` con una tabla llamada `Cajas` que incluya `Nombre`, `Largo`, `Ancho` y `Alto`.
- Hoja `Fincas` con una tabla llamada `Fincas` y la columna `Nombre`.

Las demás columnas de Catalogo se leen por su encabezado. Pueden cambiar de orden.

Antes de importar, BloomDesk guarda el Excel anterior en `data/backups`. Los registros añadidos manualmente desde BloomDesk se conservan al importar una nueva semana.

## Seguridad y alcance

- Las contraseñas de administrador, personal y catálogo se guardan como hashes, no en texto plano.
- Los usuarios pueden ser Administrador o Personal.
- Solo el administrador puede gestionar usuarios, importar Excel, editar cajas y administrar productos.
- El personal autorizado puede consultar los precios.
- El servidor escucha en `127.0.0.1`: esta versión está pensada para uso local en el mismo equipo, no para publicarse directamente en internet.
- No compartas la carpeta `data`, ya que contiene la base de datos y la clave de sesión.

## Notas del análisis de WEEK_45

En el archivo recibido se identificaron 928 filas de producto y 151 nombres de producto distintos. La tabla de cajas contiene 188 registros y la hoja Fincas contiene 102 fincas.

En el momento del análisis, los campos IMG y Tabla estaban vacíos en todos los registros, y Composición tenía contenido en 4 registros. Por eso las tarjetas sin imagen muestran un marcador neutral y las secciones vacías no se muestran hasta que completes esos campos.

## Estructura

- `app.py`: servidor, importación Excel, base de datos, seguridad y cálculos.
- `templates/`: pantallas web.
- `static/`: estilos y JavaScript.
- `data/current_week.xlsx`: Excel semanal activo.
- `data/bloomdesk.sqlite3`: se crea automáticamente al iniciar.
- `data/backups/`: copias de seguridad de los Excel reemplazados.
- `start.bat`: instala dependencias y arranca la web.
