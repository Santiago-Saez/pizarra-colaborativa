# Pizarra colaborativa — canvas + WebSocket

Front con dibujo a mano alzada, rectángulos, flechas, texto, zoom y paneo.
Back con servidor WebSocket que retransmite operaciones y guarda el historial.

> Nota: la carpeta `proyectos/` contiene un proyecto anterior (PixelLab) y no se tocó.
> La pizarra vive en la raíz: `server.js` + `public/`.

## Ejecutar

```bash
npm install
npm start
# -> http://localhost:8080
```

Abrir esa URL en dos navegadores (o ventana + incógnito) para ver colaboración,
cursores remotos y sincronización.

## Cómo cumple cada requisito

| Requisito | Implementación |
|---|---|
| Cada operación lleva id de cliente y nº de secuencia | Toda op es `{ opId: "clientId:seq", clientId, seq, kind, … }`. `seq` es un contador por cliente persistido en `localStorage`. El servidor confirma con `ack` y asigna `serverSeq` global. Reenvíos duplicados se deduplican por `opId` (`server.js`). |
| Reconexión pide lo que falta | El cliente persiste `lastServerSeq`. Al reconectar envía `hello { clientId, lastServerSeq }` y el servidor responde `welcome { ops: historial filtrado por serverSeq > lastServerSeq }`. Si en vivo se detecta un hueco (`serverSeq > last + 1`), el cliente pide `sync`. Verificado con test (punto 2). |
| Cursores con nombre y color | Mensajes efímeros `{ t:'cursor', clientId, name, color, x, y }` (coordenadas de mundo) a ~25 Hz, **no** se guardan en el historial, solo se retransmiten. Se renderizan como etiquetas flotantes y en la lista de pares. Desaparecen a los 4 s sin actualización. |
| Undo/redo local sin deshacer a otros | `undoStack`/`redoStack` solo contienen **opIds propios**. `undo` = enviar `{ kind:'retract', targetId }` de tu última op visible; `redo` = `{ kind:'restore', targetId }`. Las ops ajenas nunca entran en la pila, así que Ctrl+Z salta lo de otros pero lo oculta/restaura para todos. |

## Protocolo WS (`/ws`)

Cliente → servidor:

- `{ t:'hello'|'sync', clientId, name, color, lastServerSeq }` — presencia + catch-up.
- `{ t:'op', clientId, seq, kind:'stroke'|'rect'|'arrow'|'text', … }` — dibujo.
- `{ t:'op', clientId, seq, kind:'retract'|'restore', targetId }` — undo/redo propio.
- `{ t:'op', clientId, seq, kind:'clear' }` — limpia para todos (no deshacerable).
- `{ t:'cursor', clientId, name, color, x, y }` — efímero, no persistido.

Servidor → cliente:

- `{ t:'welcome', clientId, serverSeq, ops:[…faltantes], peers:[…] }`
- `{ t:'op', op }` — retransmisión (incluye al emisor, que confirma su optimista).
- `{ t:'ack', opId, serverSeq }` — confirmación de duplicado.
- `{ t:'cursor', … }`, `{ t:'presence', peers }`, `{ t:'left', clientId }`

El historial se persiste en `data/history.json` (se recarga al reiniciar).

## Controles

- Herramientas: mano alzada (P), borrador (E), rectángulo (R), flecha (A), texto (T), mano/paneo (H).
- Borrador: borra líneas del lápiz al tocarlas o arrastrar (propias o ajenas); lo borrado en un
  arrastre cuenta como un solo paso de Ctrl+Z. No borra rectángulos, flechas ni texto.
- Rueda = paneo · Ctrl+rueda = zoom al cursor · Espacio+arrastrar o botón central = paneo.
- Ctrl+Z / Ctrl+Shift+Z (o Ctrl+Y) = undo/redo propio. `0` con Ctrl = zoom 100 %.
- Texto: clic en el canvas, escribir, Enter para fijar (Shift+Enter = salto de línea).
