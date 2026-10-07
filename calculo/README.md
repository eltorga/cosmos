# Calculadora de Precios · GitHub Pages

Versión web responsive basada en el archivo Excel de **US Week 41**.

## Archivos que deben subirse a GitHub

- `index.html`
- `engine.py`
- `US_WEEK_ACTIVE.xlsx`

No hace falta `.nojekyll`.

## Publicar en GitHub Pages

1. Crea un repositorio nuevo en GitHub.
2. Sube los tres archivos anteriores a la raíz del repositorio.
3. Ve a **Settings → Pages**.
4. En **Build and deployment**, selecciona **Deploy from a branch**.
5. Elige `main` y `/ (root)`.
6. Pulsa **Save**.
7. Espera a que GitHub muestre la URL de Pages.

## Actualizar cada semana

La web lee el Excel directamente desde el navegador usando Python (Pyodide). Para pasar de una semana a otra:

1. Toma el nuevo Excel semanal.
2. Renómbralo a `US_WEEK_ACTIVE.xlsx`.
3. Reemplaza en GitHub el archivo anterior.
4. No necesitas modificar `index.html` ni `engine.py` mientras se mantengan las hojas y estructura usadas por el sistema.

El texto **“Actualizado hasta la semana X”** se obtiene de `Guias!M2`, y el ajuste inicial de cajas se obtiene de `Sheet1!U2`.

## Qué incluye

- US, US 48H y UK.
- Datos de cajas cargados desde `Sheet1` del Excel.
- Semáforo de aprobación según peso volumétrico y caja base.
- Ajuste U2 con recálculo inmediato.
- Selector de cajas agrupado por finca.
- Botones **+1 fila** y **+5 filas**.
- Calculadora de precio por tallo con resumen visual renovado.
- Diseño responsive para computadora, tablet y teléfono.
- Navegación por flechas entre celdas en escritorio.

## Nota

La primera carga puede tardar unos segundos porque el navegador inicializa Python. La página necesita conexión a Internet para cargar Pyodide y los iconos UIcons de Flaticon.
