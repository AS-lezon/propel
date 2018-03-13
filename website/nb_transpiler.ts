/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */
import * as acorn from "acorn/dist/acorn";
import * as walk from "acorn/dist/walk";
import { assert } from "../src/util";

const importFn = "__import";
const globalVar = "__global";
const parseOptions = { ecmaVersion: 8, allowImportExportEverywhere: true };

function noop() {}

function walkRecursiveWithAncestors(node, state, visitors) {
  const ancestors = [];
  const wrappedVisitors = {};

  for (const nodeType of Object.keys(walk.base)) {
    const visitor = visitors[nodeType] || walk.base[nodeType];
    wrappedVisitors[nodeType] = (node, state, c) => {
      const isNew = node !== ancestors[ancestors.length - 1];
      if (isNew) ancestors.push(node);
      visitor(node, state, c, ancestors);
      if (isNew) ancestors.pop();
    };
  }

  return walk.recursive(node, state, wrappedVisitors);
}

/* tslint:disable:object-literal-sort-keys*/

const importVisitors = {
  ImportDeclaration(node, state, c) {
    const spec = node.specifiers;
    const src = node.source;

    if (spec.length) {
      let cur = spec[0];
      state.edit.replace(node.start, cur.start, "var {");
      for (let i = 1; i < spec.length; i++) {
        state.edit.replace(cur.end, spec[i].start, ",");
        cur = spec[i];
      }
      state.edit.replace(cur.end, src.start, `} = {_:await ${importFn}(`);
      state.edit.replace(src.end, node.end, ")};");
    } else {
      state.edit.replace(node.start, src.start, `await ${importFn}(`);
      state.edit.replace(src.end, node.end, ");");
    }

    walk.base.ImportDeclaration(node, state, c);
  },

  ImportSpecifier(node, state, c) {
    state.edit.insertBefore(node, "_:{");
    if (node.local.start > node.imported.end) {
      state.edit.replace(node.imported.end, node.local.start, ":");
    }
    state.edit.insertAfter(node, "}");
    walk.base.ImportSpecifier(node, state, c);
  },

  ImportDefaultSpecifier(node, state, c) {
    state.edit.insertBefore(node.local, "_:{default:");
    state.edit.insertAfter(node.local, "}");
    walk.base.ImportDefaultSpecifier(node, state, c);
  },

  ImportNamespaceSpecifier(node, state, c) {
    state.edit.replace(node.start, node.local.start, "_:");
    walk.base.ImportNamespaceSpecifier(node, state, c);
  },

  // Do not recurse into functions etc.
  FunctionDeclaration: noop,
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

const evalScopeVisitors = {
  // Turn function and class declarations into expressions that assign to
  // the global object. Do not recurse into function bodies.
  ClassDeclaration(node, state, c, ancestors) {
    walk.base.ClassDeclaration(node, state, c);

    // Classes are block-scoped, so don't do any transforms if the class
    // definition isn't at top-level.
    assert(ancestors.length >= 2);
    if (ancestors[ancestors.length - 2] !== state.body) {
      return;
    }

    state.edit.insertBefore(node, `${globalVar}.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
  },

  FunctionDeclaration(node, state, c) {
    state.edit.insertBefore(node, `void (${globalVar}.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
    // Don't do any translation inside the function body, therefore there's no
    // `walk.base.FunctionDeclaration()` call here.
  },

  VariableDeclaration(node, state, c, ancestors) {
    // Turn variable declarations into assignments to the global object.
    // TODO: properly hoist `var` declarations -- that is, insert
    // `global.varname = undefined` at the very top of the block.

    // Translate all `var` declarations as they are function-scoped.
    // `let` and `const` are only translated when they appear in the top level
    // block. Note that since we don't walk into function bodies, declarations
    // inside them are never translated.
    assert(ancestors.length >= 2);
    const translateDecl =
      node.kind === "var" || ancestors[ancestors.length - 2] === state.body;

    state.translatingVariableDeclaration = translateDecl;
    walk.base.VariableDeclaration(node, state, c);
    state.translatingVariableDeclaration = false;

    if (!translateDecl) {
      return;
    }

    state.edit.replace(node.start, node.start + node.kind.length + 1, "void (");

    let decl;
    for (decl of node.declarations) {
      if (decl.init) {
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, ")");
      } else {
        // A declaration without an initializer (e.g. `var a;`) turns into
        // an assignment with undefined. Note that for destructuring
        // declarations, an initializer is mandatory, hence it is safe to just
        // assign undefined here.
        // TODO: if the declaration kind is 'var', this should probably be
        // hoisted, as this is perfectly legal javascript :/
        //   function() {
        //     console.log(foo);
        //     foo = 4;
        //     var foo;
        //   }
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, "= undefined)");
      }
    }

    // Insert after `decl` rather than node, otherwise the closing bracket
    // might end up wrapping a semicolon.
    state.edit.insertAfter(decl, ")");
  },

  VariableDeclarator(node, state, c) {
    walk.base.VariableDeclarator(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    if (node.id.type === "Identifier") {
      state.edit.insertBefore(node.id, `${globalVar}.`);
    }
  },

  ObjectPattern(node, state, c) {
    walk.base.ObjectPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const p of node.properties) {
      if (p.shorthand) {
        state.edit.insertAfter(p.value, `:${globalVar}.${p.value.name}`);
      } else if (p.value.type === "Identifier") {
        state.edit.insertBefore(p.value, `${globalVar}.`);
      }
    }
  },

  ArrayPattern(node, state, c) {
    walk.base.ArrayPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const e of node.elements) {
      if (e.type === "Identifier") {
        state.edit.insertBefore(e, `${globalVar}.`);
      }
    }
  },

  // Don't do any translation inside function (etc.) bodies.
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

/* tslint:enable:object-literal-sort-keys*/

function parseAsyncWrapped(src) {
  console.log(" source : ", src);
  // Parse javascript code which has been wrapped in an async function
  // expression, then find function body node.
  const root = acorn.parse(src, parseOptions);
  const fnExpr = root.body[0].expression;
  assert(fnExpr.type === "FunctionExpression");
  const body = fnExpr.body;
  return { body, root };
}

export class Transpiler {
  private history = new Map<number, MappedString>();
  private counter = 0;

  // Transpiles a repl cell into an async function expression.
  // The returning string has the form:
  //   (async (global, import) => {
  //     ... cell statements
  //     return last_expression_result;
  //   })
  transpile(code: string, name: string = null): string {
    const id = ++this.counter;
    let source: MappedString = new SourceFile(name, code);
    let body, root;
    let edit: EditHelper;

    // Wrap the source in an async function.
    source = new MappedString().concat(
      `(async function __transpiled_top_level_${id}__`,
      `(${globalVar}, ${importFn}, console) {\n`,
      source,
      `\n})\n//# sourceURL=__transpiled_source_${id}__`
    );

    // Translate imports into async imports.
    edit = new EditHelper(source);
    ({ body, root } = parseAsyncWrapped(source.toString()));
    walk.recursive(body, { edit }, importVisitors);
    source = edit.getResult();

    // Translate variable declarations into global assignments.
    edit = new EditHelper(source);
    ({ body, root } = parseAsyncWrapped(source.toString()));
    walkRecursiveWithAncestors(
      body,
      {
        body,
        edit,
        translatingVariableDeclaration: false
      },
      evalScopeVisitors
    );

    // If the last statement is an expression, turn it into a return statement.
    if (body.body.length > 0) {
      const last = body.body[body.body.length - 1];
      if (last.type === "ExpressionStatement") {
        edit.insertBefore(last, "return (");
        edit.insertAfter(last.expression, ")");
      }
    }

    source = edit.getResult();

    // Store the transpilation result so we can map stack traces to their
    // untranspiled counterparts.
    this.history.set(id, source);

    return source.toString();
  }

  formatErrorStack(error: Error) {
    let msg = error.stack;

    // Find the frame that corresponds with the async function wrapper that was
    // added around the source code. Rename it to "top level" and cut the stack
    // after it.
    const topLevelRe = /__transpiled_top_level_\d+__/;
    const frames = [];
    for (const frame of msg.split(/\r?\n/)) {
      if (!topLevelRe.test(frame)) {
        frames.push(frame);
      } else {
        frames.push(frame.replace(topLevelRe, "top level"));
        break;
      }
    }
    msg = frames.join("\n");

    // To the extent possible, map locations in the transpiled source code
    // to locations in the original source.
    msg = msg.replace(
      /(?:__transpiled_source_(\d+)__)(?::(\d+))?(?::(\d+))?/g,
      (substr, id, line, column) => {
        // Note that line/columns numbers in the stack trace are 1-based, but
        // MappedString positions are zero-based.
        // Also note that position information may not be available at all, e.g.
        // on Safari. In that case make a best guess.
        let source = this.history.get(+id);
        if (source && line != null) {
          line = +line;
          source = source.split("\n", line)[line - 1];
        }
        if (source && column != null) {
          column = +column;
          source = source.slice(column - 1);
        }
        if (source) {
          for (const char of source) {
            if (char.file) {
              return (
                char.file.name +
                (line != null
                  ? `:${char.line + 1}` +
                    (column != null ? `:${char.column + 1}` : "")
                  : "")
              );
            }
          }
        }
        // If source information couldn't be found, return the unmodified
        // matched substring.
        return substr;
      }
    );
    // Some browsers (Chrome) include the error message in the stack, whil
    // others (Firefox) don't.
    if (msg.indexOf(error.message) === -1) {
      msg = `${error.constructor.name}: ${error.message}\n${msg}`;
    }
    return msg;
  }
}

interface Position {
  file?: SourceFile;
  line?: number;
  column?: number;
}

class MappedChar implements Position {
  readonly char: string;
  readonly file?: SourceFile;
  readonly line?: number;
  readonly column?: number;

  constructor(char: string, { file, line, column }: Position = {}) {
    this.char = char;
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

type MappedStringLike = string | MappedChar[] | MappedString;

class MappedString extends Array<MappedChar> {
  static EMPTY = new MappedString();

  static convert(str: any, pos: Position = {}): MappedString {
    if (str instanceof MappedString) {
      return str;
    } else if (str instanceof Array) {
      return new MappedString(str);
    } else {
      return new MappedString(
        Array.from("" + str).map(char => new MappedChar(char, pos))
      );
    }
  }

  constructor(chars: number | string | MappedChar[] = [], pos?: Position) {
    if (typeof chars === "number") {
      super();
    } else if (typeof chars === "string") {
      super(...Array.from(chars).map(char => new MappedChar(char, pos)));
    } else {
      super(...chars);
    }
  }

  concat(...parts: any[]): MappedString {
    parts = parts.map(part => MappedString.convert(part));
    return Array.prototype.concat.apply(this, parts);
  }

  slice(start: number, end?: number): MappedString {
    return Array.prototype.slice.call(this, start, end);
  }

  split(separator: string, limit?: number): MappedString[] {
    if (limit === undefined) {
      limit = this.length;
    }

    // N.b.: unlike String, MappedString does not support regex as a separator.
    if (separator === "") {
      return Array.from(this)
        .slice(0, limit)
        .map(c => new MappedString([c]));
    }

    const result: MappedString[] = [];
    let remainingText: string = this.toString();
    let remainingChars: MappedString = this;

    while (limit === undefined || result.length < limit) {
      const pos = remainingText.indexOf(separator);
      if (pos < 0) {
        result.push(remainingChars);
        break;
      }

      result.push(remainingChars.slice(0, pos));
      remainingChars = remainingChars.slice(pos + separator.length);
      remainingText = remainingText.slice(pos + separator.length);
    }

    return result;
  }

  toString(): string {
    return this.reduce((str, c) => str + c.char, "");
  }
}

class SourceFile extends MappedString {
  constructor(readonly name: string, source: string) {
    super();

    let line = 0;
    let column = 0;
    let index = 0;

    for (const char of source) {
      this[index++] = new MappedChar(char, { file: this, line, column });
      if (char === "\n") {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
  }
}

class EditHelper {
  private index: MappedString[];

  constructor(source: MappedStringLike) {
    this.index = MappedString.convert(source).split("");
  }

  getResult(): MappedString {
    return new MappedString().concat(...this.index);
  }

  prepend(str: MappedStringLike): void {
    let mstr = MappedString.convert(str);
    if (this.index.length > 0) {
      mstr = mstr.concat(this.index[0]);
    }
    this.index[0] = mstr;
  }

  append(str: MappedStringLike): void {
    this.index.push(MappedString.convert(str));
  }

  replace(start, end, str: MappedStringLike): void {
    this.index[start] = MappedString.convert(str, this.index[start][0]);
    for (let i = start + 1; i < end; i++) {
      this.index[i] = MappedString.EMPTY;
    }
  }

  insertBefore({ start }, str: MappedStringLike): void {
    const mstr = MappedString.convert(str, this.index[start][0]);
    this.index[start] = mstr.concat(this.index[start]);
  }

  insertAfter({ end }, str: MappedStringLike): void {
    const mstr = MappedString.convert(str, this.index[end][0]);
    this.index[end - 1] = this.index[end - 1].concat(mstr);
  }
}
