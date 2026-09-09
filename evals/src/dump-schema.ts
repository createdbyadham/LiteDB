// Print the schema block exactly as the model receives it (npm run eval:schema).
//
// The fastest way to see what a prompt change actually did: the over-sampling
// bug that leaked customer names into every request was found with this.
import { createSqliteFixture } from './fixture';
import { serializeSchema } from '../../src/lib/promptBuilder';

async function main(): Promise<void> {
    const fixture = await createSqliteFixture();
    const qualified = process.argv.includes('--qualified');
    console.log(serializeSchema(fixture.schema, qualified));
    await fixture.close();
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
