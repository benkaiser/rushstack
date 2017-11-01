// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as argparse from 'argparse';
import * as colors from 'colors';

import {
  IBaseCommandLineDefinition,
  ICommandLineFlagDefinition,
  ICommandLineStringDefinition,
  ICommandLineStringListDefinition,
  ICommandLineIntegerDefinition,
  ICommandLineOptionDefinition
} from './CommandLineDefinition';
import {
  CommandLineParameter,
  ICommandLineParserData,
  IConverterFunction,
  CommandLineFlagParameter,
  CommandLineStringParameter,
  CommandLineStringListParameter,
  CommandLineIntegerParameter,
  CommandLineOptionParameter
} from './CommandLineParameter';

interface IParameterMetadata<TValue> {
  parameter: CommandLineParameter<TValue>;
  required: boolean;
  defaultValue: TValue | undefined;
}

/**
 * This is the common base class for CommandLineAction and CommandLineParser
 * that provides functionality for defining command-line parameters.
 *
 * @public
 */
abstract class CommandLineParameterProvider {
  private static _keyCounter: number = 0;

  /**
   * NOTE: THIS IS INTERNAL.  IN THE FUTURE, WE MAY REPLACE "argparse" WITH A DIFFERENT ENGINE.
   * @internal
   */
  protected _argumentParser: argparse.ArgumentParser;

  /* tslint:disable:no-any */
  private _parameterMetadata: Map<string, IParameterMetadata<any>>;
  private _parameters: CommandLineParameter<any>[];
  /* tslint:enable:no-any */
  private _keys: Map<string, string>;

  constructor() {
    this._parameters = [];
    // tslint:disable-next-line:no-any
    this._parameterMetadata  = new Map<string, IParameterMetadata<any>>();
    this._keys = new Map<string, string>();
  }

  /**
   * The child class should implement this hook to define its command-line parameters,
   * e.g. by calling defineFlagParameter().
   */
  protected abstract onDefineParameters(): void;

  /**
   * Defines a command-line switch whose boolean value is true if the switch is provided,
   * and false otherwise.
   *
   * @remarks
   * Example:  example-tool --debug
   */
  protected defineFlagParameter(definition: ICommandLineFlagDefinition): CommandLineFlagParameter {
    return this._createParameter(
      definition,
      { action: 'storeTrue' }
    ) as CommandLineFlagParameter;
  }

  /**
   * Defines a command-line parameter whose value is a single text string.
   *
   * @remarks
   * Example:  example-tool --message "Hello, world!"
   */
  protected defineStringParameter(definition: ICommandLineStringDefinition): CommandLineStringParameter {
    return this._createParameter(definition, undefined, definition.key) as CommandLineStringParameter;
  }

  /**
   * Defines a command-line parameter whose value is one or more text strings.
   *
   * @remarks
   * Example:  example-tool --add file1.txt --add file2.txt --add file3.txt
   */
  protected defineStringListParameter(definition: ICommandLineStringListDefinition): CommandLineStringListParameter {
    return this._createParameter(
      definition,
      { action: 'append' },
      definition.key
    ) as CommandLineStringListParameter;
  }

  /**
   * Defines a command-line parameter whose value is an integer.
   *
   * @remarks
   * Example:  example-tool l --max-attempts 5
   */
  protected defineIntegerParameter(definition: ICommandLineIntegerDefinition): CommandLineIntegerParameter {
    return this._createParameter(
      definition,
      { type: 'int' },
      definition.key
    ) as CommandLineIntegerParameter;
  }

  /**
   * Defines a command-line parameter whose value must be a string from a fixed set of
   * allowable choice (similar to an enum).
   *
   * @remarks
   * Example:  example-tool --log-level warn
   */
  protected defineOptionParameter(definition: ICommandLineOptionDefinition): CommandLineOptionParameter {
    if (!definition.options) {
      throw new Error(`When defining an option parameter, the options array must be defined.`);
    }

    if (definition.defaultValue && definition.options.indexOf(definition.defaultValue) === -1) {
      throw new Error(`Could not find default value "${definition.defaultValue}" ` +
        `in the array of available options: ${definition.options.toString()}`);
    }

    return this._createParameter(definition, {
      choices: definition.options,
      defaultValue: definition.defaultValue
    }) as CommandLineOptionParameter;
  }

  /** @internal */
  protected _processParsedData(data: ICommandLineParserData): void {
    // Fill in the values for the parameters
    for (const parameter of this._parameters) {
      parameter._setValue(data);
    }

    this._parameterMetadata.forEach((parameterMetadata: IParameterMetadata<any>) => { // tslint:disable-line:no-any
      if (parameterMetadata.parameter.value === undefined && parameterMetadata.defaultValue !== undefined) {
        parameterMetadata.parameter._setValue({
          action: '',
          [parameterMetadata.parameter._key]: parameterMetadata.defaultValue
        });
      }
    });
  }

  protected validateParameters(): void {
    const missingParameterLongNames: string[] = [];
    // tslint:disable-next-line:no-any
    this._parameterMetadata.forEach((parameterMetadata: IParameterMetadata<any>, parameterLongName: string) => {
      if (parameterMetadata.parameter.value === undefined && parameterMetadata.required) {
        missingParameterLongNames.push(parameterLongName);
      }
    });

    if (missingParameterLongNames.length > 0) {
      throw new Error(`Missing required parameters: ${missingParameterLongNames.join(', ')}`);
    }
  }

  private _getKey(
    parameterLongName: string,
    key: string = 'key_' + (CommandLineParameterProvider._keyCounter++).toString()
  ): string {
    const existingKey: string | undefined = this._keys.get(key);
    if (existingKey) {
      throw colors.red(`The parameter "${parameterLongName}" tried to define a key which was already ` +
        `defined by the "${existingKey}" parameter. Ensure that the keys values are unique.`);
    }

    this._keys.set(key, parameterLongName);
    return key;
  }

  private _createParameter<TValue>(
    definition: IBaseCommandLineDefinition<TValue>,
    argparseOptions?: argparse.ArgumentOptions,
    key?: string,
    converter?: IConverterFunction<any> // tslint:disable-line:no-any
  ): CommandLineParameter<TValue> {
    const names: string[] = [];
    if (definition.parameterShortName) {
      names.push(definition.parameterShortName);
    }

    names.push(definition.parameterLongName);

    const result: CommandLineParameter<TValue> = new CommandLineParameter<TValue>(
      this._getKey(definition.parameterLongName, key),
      converter
    );

    this._parameters.push(result);

    const baseArgparseOptions: argparse.ArgumentOptions = {
      help: definition.description,
      dest: result._key
    };

    Object.keys(argparseOptions || {}).forEach((keyVal: string) => {
      baseArgparseOptions[keyVal] = (argparseOptions || {})[keyVal];
    });

    this._argumentParser.addArgument(names, baseArgparseOptions);

    this._parameterMetadata.set(
      definition.parameterLongName,
      {
        required: !!definition.required,
        parameter: result,
        defaultValue: definition.defaultValue
      }
    );

    return result;
  }
}

export default CommandLineParameterProvider;
