// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import {
  FileSystem,
  AlreadyReportedError,
  Executable,
  EnvironmentMap,
  ITerminal,
  Colors,
  Terminal,
  ConsoleTerminalProvider
} from '@rushstack/node-core-library';
import { PrintUtilities } from '@rushstack/terminal';

import { RushConfiguration } from '../api/RushConfiguration';
import { NodeJsCompatibility } from '../logic/NodeJsCompatibility';
import { SpawnSyncReturns } from 'child_process';
import { ILaunchOptions } from '../api/Rush';
import { InstallHelpers } from '../logic/installManager/InstallHelpers';

export interface ILaunchRushPnpmInternalOptions extends ILaunchOptions {}

const RUSH_SKIP_CHECKS_PARAMETER: string = '--rush-skip-checks';

enum CommandKind {
  KnownSafe,
  ShowWarning,
  Blocked
}

export class RushPnpmCommandLine {
  private static _knownCommandMap: Map<string, CommandKind> = new Map<string, CommandKind>([
    ['add', CommandKind.Blocked],
    ['audit', CommandKind.KnownSafe],
    ['exec', CommandKind.KnownSafe],
    ['import', CommandKind.Blocked],
    ['install', CommandKind.Blocked],
    [/* synonym */ 'i', CommandKind.Blocked],
    ['install-test', CommandKind.Blocked],
    [/* synonym */ 'it', CommandKind.Blocked],
    ['link', CommandKind.ShowWarning],
    [/* synonym */ 'ln', CommandKind.ShowWarning],
    ['list', CommandKind.KnownSafe],
    [/* synonym */ 'ls', CommandKind.KnownSafe],
    ['outdated', CommandKind.KnownSafe],
    ['pack', CommandKind.KnownSafe],
    ['prune', CommandKind.KnownSafe],
    ['publish', CommandKind.KnownSafe],
    ['rebuild', CommandKind.KnownSafe],
    [/* synonym */ 'rb', CommandKind.KnownSafe],
    ['remove', CommandKind.ShowWarning],
    [/* synonym */ 'rm', CommandKind.ShowWarning],
    ['root', CommandKind.KnownSafe],
    ['run', CommandKind.KnownSafe],
    ['start', CommandKind.KnownSafe],
    ['store', CommandKind.KnownSafe],
    ['test', CommandKind.KnownSafe],
    [/* synonym */ 't', CommandKind.KnownSafe],
    ['unlink', CommandKind.ShowWarning],
    ['update', CommandKind.ShowWarning],
    [/* synonym */ 'up', CommandKind.ShowWarning],
    ['why', CommandKind.KnownSafe]
  ]);

  public static launch(launcherVersion: string, options: ILaunchRushPnpmInternalOptions): void {
    // Node.js can sometimes accidentally terminate with a zero exit code  (e.g. for an uncaught
    // promise exception), so we start with the assumption that the exit code is 1
    // and set it to 0 only on success.
    process.exitCode = 1;

    const { terminalProvider } = options;
    const terminal = new Terminal(terminalProvider || new ConsoleTerminalProvider());

    try {
      // Are we in a Rush repo?
      let rushConfiguration: RushConfiguration | undefined = undefined;
      if (RushConfiguration.tryFindRushJsonLocation()) {
        rushConfiguration = RushConfiguration.loadFromDefaultLocation({ showVerbose: true });
      }

      NodeJsCompatibility.warnAboutCompatibilityIssues({
        isRushLib: true,
        alreadyReportedNodeTooNewError: !!options.alreadyReportedNodeTooNewError,
        rushConfiguration
      });

      if (!rushConfiguration) {
        throw new Error(
          'The "rush-pnpm" command must be executed in a folder that is under a Rush workspace folder'
        );
      }

      if (rushConfiguration.packageManager !== 'pnpm') {
        throw new Error(
          'The "rush-pnpm" command requires your rush.json to be configured to use the PNPM package manager'
        );
      }

      if (!rushConfiguration.pnpmOptions.useWorkspaces) {
        throw new Error(
          'The "rush-pnpm" command requires the "useWorkspaces" setting to be enabled in rush.json'
        );
      }

      const workspaceFolder: string = rushConfiguration.commonTempFolder;
      const workspaceFilePath: string = path.join(workspaceFolder, 'pnpm-workspace.yaml');

      if (!FileSystem.exists(workspaceFilePath)) {
        terminal.writeErrorLine('Error: The PNPM workspace file has not been generated:');
        terminal.writeErrorLine(`  ${workspaceFilePath}\n`);
        terminal.writeLine(Colors.cyan(`Do you need to run "rush install" or "rush update"?`));
        throw new AlreadyReportedError();
      }

      if (!FileSystem.exists(rushConfiguration.packageManagerToolFilename)) {
        terminal.writeErrorLine('Error: The PNPM local binary has not been installed yet.');
        terminal.writeLine('\n' + Colors.cyan(`Do you need to run "rush install" or "rush update"?`));
        throw new AlreadyReportedError();
      }

      // 0 = node.exe
      // 1 = rush-pnpm
      const pnpmArgs: string[] = process.argv.slice(2);

      RushPnpmCommandLine._validatePnpmUsage(pnpmArgs, terminal);

      const pnpmEnvironmentMap: EnvironmentMap = new EnvironmentMap(process.env);
      pnpmEnvironmentMap.set('NPM_CONFIG_WORKSPACE_DIR', workspaceFolder);

      if (rushConfiguration.pnpmOptions.pnpmStorePath) {
        pnpmEnvironmentMap.set('NPM_CONFIG_STORE_DIR', rushConfiguration.pnpmOptions.pnpmStorePath);
      }

      if (rushConfiguration.pnpmOptions.environmentVariables) {
        for (const [envKey, { value: envValue, override }] of Object.entries(
          rushConfiguration.pnpmOptions.environmentVariables
        )) {
          if (override) {
            pnpmEnvironmentMap.set(envKey, envValue);
          } else {
            if ('undefined' === typeof pnpmEnvironmentMap.get(envKey)) {
              pnpmEnvironmentMap.set(envKey, envValue);
            }
          }
        }
      }

      const result: SpawnSyncReturns<string> = Executable.spawnSync(
        rushConfiguration.packageManagerToolFilename,
        pnpmArgs,
        {
          environmentMap: pnpmEnvironmentMap,
          stdio: 'inherit'
        }
      );
      if (result.error) {
        throw new Error('Failed to invoke PNPM: ' + result.error);
      }
      if (result.status === null) {
        throw new Error('Failed to invoke PNPM: Spawn completed without an exit code');
      }
      process.exitCode = result.status;
    } catch (error) {
      if (!(error instanceof AlreadyReportedError)) {
        const prefix: string = 'ERROR: ';
        terminal.writeErrorLine('\n' + PrintUtilities.wrapWords(prefix + error.message));
      }
    }
  }

  private static _validatePnpmUsage(pnpmArgs: string[], terminal: ITerminal): void {
    if (pnpmArgs[0] === RUSH_SKIP_CHECKS_PARAMETER) {
      pnpmArgs.shift();
      // Ignore other checks
      return;
    }

    if (pnpmArgs.length === 0) {
      return;
    }
    const firstArg: string = pnpmArgs[0];

    // Detect common safe invocations
    if (pnpmArgs.indexOf('-h') >= 0 || pnpmArgs.indexOf('--help') >= 0 || pnpmArgs.indexOf('-?') >= 0) {
      return;
    }

    if (pnpmArgs.length === 1) {
      if (firstArg === '-v' || firstArg === '--version') {
        return;
      }
    }

    const BYPASS_NOTICE: string = `To bypass this check, add "${RUSH_SKIP_CHECKS_PARAMETER}" as the very first command line option.`;

    if (!/^[a-z]+([a-z0-9\-])*$/.test(firstArg)) {
      // We can't parse this CLI syntax
      terminal.writeErrorLine(
        `Warning: The "rush-pnpm" wrapper expects a command verb before "${firstArg}"\n`
      );
      terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
      throw new AlreadyReportedError();
    } else {
      const commandName: string = firstArg;

      // Also accept SKIP_RUSH_CHECKS_PARAMETER immediately after the command verb
      if (pnpmArgs[1] === RUSH_SKIP_CHECKS_PARAMETER) {
        pnpmArgs.splice(1, 1);
        return;
      }

      if (pnpmArgs.indexOf(RUSH_SKIP_CHECKS_PARAMETER) >= 0) {
        // We do not attempt to parse PNPM's complete CLI syntax, so we cannot be sure how to interpret
        // strings that appear outside of the specific patterns that this parser recognizes
        terminal.writeErrorLine(
          PrintUtilities.wrapWords(
            `Error: The "${RUSH_SKIP_CHECKS_PARAMETER}" option must be the first parameter for the "rush-pnpm" command.`
          )
        );
        throw new AlreadyReportedError();
      }

      // Warn about commands known not to work
      switch (commandName) {
        case 'add':
        case 'install':
        case 'i':
        case 'install-test':
        case 'it':
          terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is incompatible with Rush's environment.` +
                ` Use the "rush install" or "rush update" commands instead.`
            ) + '\n'
          );
          terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
      }

      const commandKind: CommandKind | undefined = RushPnpmCommandLine._knownCommandMap.get(commandName);
      switch (commandKind) {
        case CommandKind.KnownSafe:
          break;
        case CommandKind.ShowWarning:
          terminal.writeWarningLine(
            PrintUtilities.wrapWords(
              `Warning: The "pnpm ${commandName}" command makes changes that may invalidate Rush's workspace state.`
            ) + '\n'
          );
          terminal.writeWarningLine(`==> Consider running "rush install" or "rush update" afterwards.\n`);
          break;
        case CommandKind.Blocked:
          terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is known to be incompatible with Rush's environment.`
            ) + '\n'
          );
          terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        default:
          terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command has not been tested with Rush's environment. It may be incompatible.`
            ) + '\n'
          );
          terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
      }
    }
  }
}
