import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { parseEnv } from 'node:util';

const action = process.argv[2];
if (!['plan', 'apply'].includes(action)) {
  console.error('Uso: node scripts/infra.mjs plan|apply');
  process.exit(1);
}

const env = {
  ...(existsSync('.env.deploy') ? parseEnv(readFileSync('.env.deploy', 'utf8')) : {}),
  ...process.env,
};
const region = env.TF_VAR_region ?? 'sa-east-1';
if (env.AWS_REGION && env.AWS_REGION !== region) {
  console.error('AWS_REGION e TF_VAR_region devem coincidir.');
  process.exit(1);
}
env.AWS_REGION = region;
const run = (command, args, options = {}) =>
  execFileSync(command, args, { env, stdio: 'inherit', ...options });
const planPath = 'infra/deployment.tfplan';

try {
  if (action === 'plan') {
    rmSync(planPath, { force: true });
    run('npm', ['run', 'check']);
    run('terraform', ['-chdir=infra', 'init', '-input=false']);
    run('terraform', ['-chdir=infra', 'fmt', '-check', '-recursive']);
    run('terraform', ['-chdir=infra', 'validate']);
    run('terraform', ['-chdir=infra', 'test']);
    run('aws', ['sts', 'get-caller-identity']);
    run('terraform', ['-chdir=infra', 'plan', '-input=false', '-out=deployment.tfplan']);
  } else {
    // Apply the reviewed saved plan, rather than generating a different plan silently.
    if (!existsSync(planPath)) {
      throw new Error('Execute npm run plan antes de npm run deploy.');
    }
    run('terraform', ['-chdir=infra', 'apply', '-input=false', 'deployment.tfplan'], {
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    rmSync(planPath, { force: true });
    run('terraform', ['-chdir=infra', 'output']);
  }
} catch (error) {
  if (error.stderr?.length) process.stderr.write(error.stderr);
  if (error.stderr?.toString().includes('Saved plan is stale')) {
    rmSync(planPath, { force: true });
    console.error(
      'O state mudou após a criação do plano. O plano obsoleto foi removido. Execute npm run plan, revise o novo plano e depois execute npm run deploy.',
    );
  } else {
    console.error(
      error.status ? 'Operação interrompida; confira a etapa que falhou.' : error.message,
    );
  }
  process.exitCode = 1;
}
