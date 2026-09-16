import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');

const STEPS = [
	{
		name: 'Reference data',
		script: 'extract-reference-data.mjs',
	},
	{
		name: 'Site licenses',
		script: 'extract-site-licenses.mjs',
	},
	{
		name: 'Subscriptions',
		script: 'extract-subscriptions.mjs',
	},
	{
		name: 'Subscription Log export',
		script: 'extract-subscription-log.mjs',
	},
	{
		name: 'Access Granted',
		script: 'extract-access-granted.mjs',
	},
];

function formatDuration(milliseconds) {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes === 0) {
		return `${seconds}s`;
	}

	return `${minutes}m ${seconds}s`;
}

function runStep(step, stepNumber, totalSteps) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();

		console.log('');
		console.log('============================================================');
		console.log(`[${stepNumber}/${totalSteps}] ${step.name}`);
		console.log(`Script: scripts/${step.script}`);
		console.log('============================================================');
		console.log('');

		const scriptPath = path.join(__dirname, step.script);

		const child = spawn(process.execPath, [scriptPath], {
			cwd: PROJECT_ROOT,
			env: process.env,
			stdio: 'inherit',
		});

		child.once('error', (error) => {
			reject(
				new Error(`${step.name} could not be started: ${error.message}`, {
					cause: error,
				}),
			);
		});

		child.once('exit', (code, signal) => {
			const elapsed = formatDuration(Date.now() - startedAt);

			if (code === 0) {
				console.log('');
				console.log(
					`[${stepNumber}/${totalSteps}] ${step.name} completed in ${elapsed}.`,
				);

				resolve();
				return;
			}

			if (signal) {
				reject(
					new Error(
						`${step.name} terminated by signal ${signal} after ${elapsed}.`,
					),
				);
				return;
			}

			reject(
				new Error(
					`${step.name} failed with exit code ${code} after ${elapsed}.`,
				),
			);
		});
	});
}

async function main() {
	const startedAt = Date.now();

	console.log('');
	console.log('Piano.io complete data refresh');
	console.log(`Started: ${new Date().toISOString()}`);
	console.log('');
	console.log('Refresh sequence:');

	for (const [index, step] of STEPS.entries()) {
		console.log(`  ${index + 1}. ${step.name}`);
	}

	for (const [index, step] of STEPS.entries()) {
		await runStep(step, index + 1, STEPS.length);
	}

	console.log('');
	console.log('============================================================');
	console.log('Complete data refresh succeeded');
	console.log(`Completed: ${new Date().toISOString()}`);
	console.log(`Elapsed: ${formatDuration(Date.now() - startedAt)}`);
	console.log('============================================================');
	console.log('');
}

try {
	await main();
} catch (error) {
	console.error('');
	console.error('============================================================');
	console.error('Complete data refresh failed');
	console.error('============================================================');
	console.error('');
	console.error(error?.stack || error);
	console.error('');
	console.error('No remaining refresh steps will be run.');

	process.exitCode = 1;
}
