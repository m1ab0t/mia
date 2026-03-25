/**
 * CLI command: mia persona
 *
 * Manage personality personas from the terminal.
 *
 * Usage:
 *   mia persona              — list all personas
 *   mia persona list         — list all personas
 *   mia persona set <name>   — switch active persona
 *   mia persona show [name]  — view persona content
 */

import { listPersonas, setActivePersona, getActivePersona, loadPersonaContent, PERSONAS_DIR } from '../../personas/index';
import { x, dim as d, cyan as c, green as g, red as r } from '../../utils/ansi.js';
import { getErrorMessage } from '../../utils/error-message.js';

export async function handlePersonaCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  if (sub === 'set' || sub === 'use' || sub === 'switch') {
    const name = args[1];
    if (!name) {
      console.error(`\n  ${r}Usage:${x} mia persona set <name>\n`);
      process.exit(1);
    }

    try {
      const active = await setActivePersona(name);
      console.log(`\n  ${g}✓${x} Switched to ${c}${active}${x} persona\n`);
      console.log(`  ${d}Takes effect on next message.${x}\n`);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      console.error(`\n  ${r}✗${x} ${msg}\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'show' || sub === 'view') {
    const name = args[1] ?? await getActivePersona();
    const content = await loadPersonaContent(name);
    if (!content) {
      console.error(`\n  ${r}✗${x} Persona "${name}" not found.\n`);
      process.exit(1);
    }
    console.log(`\n  ${c}${name}${x}\n`);
    console.log(content);
    console.log('');
    return;
  }

  // list (default)
  const personas = await listPersonas();

  if (personas.length === 0) {
    console.log(`\n  No personas found. Add .md files to ${c}${PERSONAS_DIR}${x}\n`);
    return;
  }

  console.log(`\n  ${d}Personas${x}  ${d}(${PERSONAS_DIR})${x}\n`);

  for (const p of personas) {
    const active = p.isActive ? ` ${g}← active${x}` : '';
    const custom = p.isPreset ? '' : ` ${d}(custom)${x}`;
    const desc = p.description ? `  ${d}${p.description}${x}` : '';
    console.log(`  ${c}${p.name}${x}${active}${custom}`);
    if (desc) console.log(`  ${desc}`);
  }

  console.log(`\n  ${d}Switch with:${x} mia persona set <name>\n`);
}
