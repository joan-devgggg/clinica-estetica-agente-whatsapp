# Buscador de clientes

## Arranque rápido

1. Copia `config.example.json` a `config.json` y adapta los datos del cliente.
2. Si quieres un perfil separado, copia `client.example.json` a `client.json`.
3. Rellena las variables de entorno necesarias.
4. Ejecuta el bot como siempre en tu entorno actual.

## Estructura por cliente

- `config.json`: reglas, prompts, ciudades, IA y storage.
- `client.json`: identidad del negocio y referencia al config.
- `config.example.json`: plantilla base para clonar nuevos clientes.

## Tests

Ejecuta los tests básicos con:

```bash
node tests/helpers.test.js
```

## Qué se puede personalizar

- ciudades
- preguntas
- validaciones
- prompt del sistema
- comportamiento de follow-ups
- storage / Airtable
