"use strict";
import * as child_process from 'child_process';
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import * as settings from "./../common/configSettings";
import * as utils from "./../common/utils";
let ncp = require("copy-paste");

// where to find the Python binary within a conda env
const CONDA_RELATIVE_PY_PATH = utils.IS_WINDOWS ? ['python'] : ['bin', 'python']
const REPLACE_PYTHONPATH_REGEXP = /("python\.pythonPath"\s*:\s*)"(.*)"/g;
const CHECK_PYTHON_INTERPRETER_REGEXP = utils.IS_WINDOWS ? /^python(\d+(.\d+)?)?\.exe$/ : /^python(\d+(.\d+)?)?$/;

interface PythonPathSuggestion {
    label: string, // myenvname
    path: string,  // /full/path/to/bin/python
    type: string   // conda
}

interface PythonPathQuickPickItem extends vscode.QuickPickItem {
    path: string
}

function isPythonInterpreter(filePath: string): boolean {
    return CHECK_PYTHON_INTERPRETER_REGEXP.test(filePath);
}

function getSearchPaths(): string[] {
    if (utils.IS_WINDOWS) {
        return [
            'C:\\Python2.7',
            'C:\\Python27',
            'C:\\Python3.4',
            'C:\\Python34',
            'C:\\Python3.5',
            'C:\\Python35',
            'C:\\Python35-32',
            'C:\\Anaconda',
            'C:\\Anaconda3',
            'C:\\Program Files (x86)\\Python 2.7',
            'C:\\Program Files (x86)\\Python 3.4',
            'C:\\Program Files (x86)\\Python 3.5',
            'C:\\Program Files (x64)\\Python 2.7',
            'C:\\Program Files (x64)\\Python 3.4',
            'C:\\Program Files (x64)\\Python 3.5',
            'C:\\Program Files\\Python 2.7',
            'C:\\Program Files\\Python 3.4',
            'C:\\Program Files\\Python 3.5',
            'C:\\Program Files\\Anaconda',
            'C:\\Program Files\\Anaconda3'
        ];
    } else {
        return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    }
}

export function activateSetInterpreterProvider():vscode.Disposable {
    return vscode.commands.registerCommand("python.setInterpreter", setInterpreter);
}

function lookForInterpretersInPath(pathToCheck: string): Promise<string[]> {
    return new Promise<string[]>(resolve => {
        // Now look for Interpreters in this directory
        fs.readdir(pathToCheck, (err, subDirs) => {
            if (err) {
                return resolve([]);
            }
            const interpreters = subDirs
                .filter(subDir => CHECK_PYTHON_INTERPRETER_REGEXP.test(subDir))
                .map(subDir => path.join(pathToCheck, subDir));
            resolve(interpreters);
        });
    });
}
function lookForInterpretersInVirtualEnvs(pathToCheck: string): Promise<PythonPathSuggestion[]> {
    return new Promise<PythonPathSuggestion[]>(resolve => {
        // Now look for Interpreters in this directory
        fs.readdir(pathToCheck, (err, subDirs) => {
            if (err) {
                return resolve([]);
            }
            const envsInterpreters = [];
            const promises = subDirs.map(subDir => {
                subDir = path.join(pathToCheck, subDir);
                const interpreterFolder = utils.IS_WINDOWS ? path.join(subDir, 'scripts') : path.join(subDir, 'bin');
                return lookForInterpretersInPath(interpreterFolder);
            });
            Promise.all<string[]>(promises).then(pathsWithInterpreters => {
                pathsWithInterpreters.forEach(interpreters => {
                    interpreters.map(interpter => {
                        envsInterpreters.push({
                            label: path.basename(interpter), path: interpter, type: ''
                        });
                    })
                });

                resolve(envsInterpreters);
            })
        });
    });
}
function suggestionsFromKnownPaths(): Promise<PythonPathSuggestion[]> {
    return new Promise(resolve => {
        const validPaths = getSearchPaths().map(p => {
            return utils.validatePath(p).then(validatedPath => {
                if (validatedPath.length === 0) {
                    return Promise.resolve<string[]>([]);
                }

                return lookForInterpretersInPath(validatedPath);
            });
        });
        Promise.all<string[]>(validPaths).then(listOfInterpreters => {
            const suggestions: PythonPathSuggestion[] = [];
            listOfInterpreters.forEach(interpreters => {
                interpreters.filter(interpter => interpter.length > 0).map(interpter => {
                    suggestions.push({
                        label: path.basename(interpter), path: interpter, type: ''
                    });
                });
            });
            resolve(suggestions);
        });
    });
}
function suggestionsFromConda(): Promise<PythonPathSuggestion[]> {
    return new Promise((resolve, reject) => {
        // interrogate conda (if it's on the path) to find all environments
        child_process.execFile('conda', ['info', '--json'], (error, stdout, stderr) => {
            try {
                const info = JSON.parse(stdout)

                // envs reported as e.g.: /Users/bob/miniconda3/envs/someEnv
                const envs = <string[]>info['envs']

                // The root of the conda environment is itself a Python interpreter
                envs.push(info["default_prefix"])

                const suggestions = envs.map(env => ({
                    label: path.basename(env),  // e.g. someEnv, miniconda3
                    path: path.join(env, ...CONDA_RELATIVE_PY_PATH),
                    type: 'conda',
                }))
                resolve(suggestions)
            } catch (e) {
                // Failed because either:
                //   1. conda is not installed
                //   2. `conda info --json` has changed signature
                //   3. output of `conda info --json` has changed in structure
                // In all cases, we can't offer conda pythonPath suggestions.
                return resolve([])
            }
        })
    });
}

function suggestionToQuickPickItem(suggestion: PythonPathSuggestion): PythonPathQuickPickItem {
    let detail = suggestion.path;
    if (suggestion.path.startsWith(vscode.workspace.rootPath)) {
        detail = path.relative(vscode.workspace.rootPath, suggestion.path);
    }
    detail = utils.IS_WINDOWS ? detail.replace(/\\/g, "/") : detail;
    return {
        label: suggestion.label,
        description: suggestion.type,
        detail: detail,
        path: utils.IS_WINDOWS ? suggestion.path.replace(/\\/g, "/") : suggestion.path
    }
}

function suggestPythonPaths(): Promise<PythonPathQuickPickItem[]> {
    // For now we only interrogate conda for suggestions.
    const condaSuggestions = suggestionsFromConda();
    const knownPathSuggestions = suggestionsFromKnownPaths();
    const virtualEnvSuggestions = lookForInterpretersInVirtualEnvs(vscode.workspace.rootPath);

    // Here we could also look for virtualenvs/default install locations...

    return Promise.all<PythonPathSuggestion[]>([condaSuggestions, knownPathSuggestions, virtualEnvSuggestions]).then(suggestions => {
        const quickPicks: PythonPathQuickPickItem[] = [];
        suggestions.forEach(list => {
            quickPicks.push(...list.map(suggestionToQuickPickItem));
        });

        return quickPicks;
    });
}

function setPythonPath(pythonPath: string, created: boolean = false) {
    if (pythonPath.startsWith(vscode.workspace.rootPath)) {
        pythonPath = path.join('${workspaceRoot}', path.relative(vscode.workspace.rootPath, pythonPath));
    }
    const pythonConfig = vscode.workspace.getConfiguration('python');
    pythonConfig.update('pythonPath', pythonPath).then(() => {
        //Done
    }, reason => {
        vscode.window.showErrorMessage(`Failed to set 'pythonPath'. Error: ${reason.message}`);
        console.error(reason);
    })
}

function presentQuickPickOfSuggestedPythonPaths() {
    const currentPythonPath = settings.PythonSettings.getInstance().pythonPath;
    const quickPickOptions: vscode.QuickPickOptions = {
        matchOnDetail: true,
        matchOnDescription: false,
        placeHolder: `current: ${currentPythonPath}`
    }

    suggestPythonPaths().then(suggestions => {
        vscode.window.showQuickPick(suggestions, quickPickOptions).then(
            value => {
                if (value !== undefined) {
                    setPythonPath(value.path);
                }
            });
    });
}

function setInterpreter() {
    presentQuickPickOfSuggestedPythonPaths();
}