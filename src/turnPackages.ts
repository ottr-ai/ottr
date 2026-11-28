import { existsSync, readFileSync } from "node:fs";
import {
	ensureProjectPython,
	ensurePython,
	mergeRequirements,
	parseRequirements,
	pythonPathDir,
	pythonPathFor,
	requirementsListPath,
} from "./python.ts";
import {
	buildToolsPath,
	ensureProjectTools,
	installTools,
	readToolsList,
} from "./tools.ts";

/** The board reads trusted lists; an optional provision home holds the installs. */
export async function prepareTurnPackages(
	project: string,
	listHome: string,
	destinationHome?: string,
	runPython?: Parameters<typeof ensurePython>[2],
): Promise<{ lines: string[]; pathDir: string | null }> {
	const home = destinationHome ?? listHome;
	let lines: string[];
	let venvBin: string;
	if (destinationHome === undefined) {
		lines = [
			...(await ensureProjectTools(project, listHome)),
			...(await ensureProjectPython(project, listHome, runPython)),
		];
		venvBin = pythonPathDir(project, listHome);
	} else {
		lines = await installTools(
			[...readToolsList("_all", listHome), ...readToolsList(project, listHome)],
			home,
		);
		const read = (name: string) => {
			const file = requirementsListPath(name, listHome);
			return existsSync(file)
				? parseRequirements(readFileSync(file, "utf8"))
				: [];
		};
		const requirements = mergeRequirements(read(project), read("_all"));
		lines.push(...(await ensurePython(requirements, home, runPython)));
		venvBin = pythonPathFor(requirements, home);
	}
	if (venvBin !== "")
		lines.push("pip: the project venv's bin dir is on this turn's PATH");
	const pathDir =
		[
			buildToolsPath(
				[
					...readToolsList(project, listHome),
					...readToolsList("_all", listHome),
				],
				home,
			),
			venvBin,
		]
			.filter(Boolean)
			.join(":") || null;
	return { lines, pathDir };
}
