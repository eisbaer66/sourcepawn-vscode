import {
  CompletionItemKind,
  Range,
  workspace as Workspace,
  Location,
  Position,
} from "vscode";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { URI } from "vscode-uri";

import { ItemsRepository } from "../Backend/spItemsRepository";
import { FileItems } from "../Backend/spFilesRepository";
import { SPItem } from "../Backend/Items/spItems";
import { State } from "./stateEnum";
import { readDefine } from "./readDefine";
import { readMacro } from "./readMacro";
import { readInclude } from "./readInclude";
import { readEnum } from "./readEnum";
import { readLoopVariable } from "./readLoopVariable";
import { readVariable } from "./readVariable";
import { readProperty } from "./readProperty";
import { readTypeDef } from "./readTypeDef";
import { readTypeSet } from "./readTypeSet";
import { readFunction } from "./readFunction";
import { consumeComment } from "./consumeComment";
import { searchForReferencesInString } from "./searchForReferencesInString";
import { handleReferenceInParser } from "./handleReferencesInParser";
import { readMethodMap } from "./readMethodMap";
import { manageState } from "./manageState";
import { purgeCalls, positiveRange, parentCounter } from "./utils";
import { globalIdentifier, globalItem } from "../Misc/spConstants";
import { ParseState } from "./interfaces";
import { FunctionItem } from "../Backend/Items/spFunctionItem";
import { MethodItem } from "../Backend/Items/spMethodItem";
import { PropertyItem } from "../Backend/Items/spPropertyItem";
import { MethodMapItem } from "../Backend/Items/spMethodmapItem";
import { EnumStructItem } from "../Backend/Items/spEnumStructItem";
import { ConstantItem } from "../Backend/Items/spConstantItem";

export function parseFile(
  file: string,
  items: FileItems,
  itemsRepository: ItemsRepository,
  searchTokens: boolean,
  IsBuiltIn: boolean
) {
  if (!existsSync(file)) {
    return;
  }
  let data = readFileSync(file, "utf-8");

  // Test for symbolic links
  let match = data.match(/^(?:\.\.\/)+(?:[\/\w\-])+\.\w+/);
  if (match !== null) {
    let folderpath = dirname(file);
    file = resolve(folderpath, match[0]);
    data = readFileSync(file, "utf-8");
  }
  parseText(data, file, items, itemsRepository, searchTokens, IsBuiltIn);
}

export function parseText(
  data: string,
  file: string,
  items: FileItems,
  itemsRepository: ItemsRepository,
  searchTokens,
  IsBuiltIn: boolean
) {
  if (data === undefined) {
    return; // Asked to parse empty file
  }
  let lines = data.split("\n");
  let parser = new Parser(lines, file, IsBuiltIn, items, itemsRepository);
  parser.parse(searchTokens);
}

export class Parser {
  fileItems: FileItems;
  items: SPItem[];
  state: State[];
  scratch: any;
  state_data: any;
  lines: string[];
  lineNb: number;
  filePath: string;
  IsBuiltIn: boolean;
  documents: Set<string>;
  lastFuncLine: number;
  lastFunc: FunctionItem | ConstantItem;
  methodsAndProperties: (MethodItem | PropertyItem)[];
  funcsAndMethodsInFile: (FunctionItem | MethodItem)[];
  MmEsInFile: (MethodMapItem | EnumStructItem)[];
  referencesMap: Map<string, SPItem>;
  macroArr: string[];
  itemsRepository: ItemsRepository;
  debugging: boolean;
  anonymousEnumCount: number;
  deprecated: string | undefined;

  constructor(
    lines: string[],
    filePath: string,
    IsBuiltIn: boolean,
    completions: FileItems,
    itemsRepository: ItemsRepository
  ) {
    this.fileItems = completions;
    this.state = [State.None];
    this.lineNb = 0;
    this.lines = lines;
    this.filePath = filePath;
    this.IsBuiltIn = IsBuiltIn;
    this.documents = itemsRepository.documents;
    this.lastFuncLine = -1;
    this.lastFunc = globalItem;
    // Get all the items from the itemsRepository for this file
    this.items = itemsRepository.getAllItems(URI.file(this.filePath));
    this.macroArr = this.getAllMacros(this.items);
    this.itemsRepository = itemsRepository;
    let debugSetting = Workspace.getConfiguration("sourcepawn").get(
      "trace.server"
    );
    this.debugging = debugSetting == "messages" || debugSetting == "verbose";
    this.anonymousEnumCount = 0;
    this.methodsAndProperties = [];
    this.funcsAndMethodsInFile = [];
    this.MmEsInFile = [];
    this.referencesMap = new Map<string, SPItem>();
  }

  parse(searchReferences: boolean): void {
    let line = this.lines.shift();
    if (!searchReferences) {
      // Purge all comments from the file.
      let uri = URI.file(this.filePath);
      let oldFileItems = this.itemsRepository.fileItems.get(uri.toString());
      let oldRefs = new Map<string, Location[]>();
      if (oldFileItems !== undefined) {
        oldFileItems.forEach((v: SPItem, k) => {
          if (v.references !== undefined && v.references.length > 0) {
            let oldItemRefs = v.references.filter(
              (e) => e.uri.fsPath !== this.filePath
            );
            if (oldItemRefs.length > 0) {
              oldRefs.set(k, oldItemRefs);
            }
          }
        });
      }

      // Always add "sourcemod.inc" as an include.
      readInclude(this, "sourcemod".match(/(.*)/));
      while (line !== undefined) {
        this.interpLine(line);
        line = this.lines.shift();
        this.lineNb++;
      }
      oldRefs.forEach((v, k) => {
        let item = this.fileItems.get(k);
        if (item !== undefined) {
          item.references.push(...v);
        }
      });
      return;
    }

    this.getReferencesMap();

    let lastFunc: FunctionItem | MethodItem | undefined;
    let lastMMorES: MethodMapItem | EnumStructItem | undefined;

    while (line !== undefined) {
      const pos = new Position(this.lineNb, 0);

      if (!lastFunc || !lastFunc.fullRange.contains(pos)) {
        if (
          this.funcsAndMethodsInFile.length > 0 &&
          this.funcsAndMethodsInFile[0].fullRange.contains(pos)
        ) {
          lastFunc = this.funcsAndMethodsInFile.shift();
        } else {
          lastFunc = undefined;
        }
      }

      if (!lastMMorES || !lastMMorES.fullRange.contains(pos)) {
        if (
          this.MmEsInFile.length > 0 &&
          this.MmEsInFile[0].fullRange.contains(pos)
        ) {
          lastMMorES = this.MmEsInFile.shift();
        } else {
          lastMMorES = undefined;
        }
      }

      const parseState: ParseState = {
        bComment: false,
        lComment: false,
        sString: false,
        dString: false,
      };

      searchForReferencesInString(line, handleReferenceInParser, {
        parser: this,
        parseState: parseState,
        scope: `-${lastFunc ? lastFunc.name : globalIdentifier}-${
          lastMMorES ? lastMMorES.name : globalIdentifier
        }`,
        offset: 0,
      });
      line = this.lines.shift();
      this.lineNb++;
    }
  }

  interpLine(line: string) {
    // EOF
    if (line === undefined) return;

    // Match trailing single line comments
    let match = line.match(/^\s*[^\/\/\s]+(\/\/.+)$/);
    if (match) {
      return;
    }

    // Match trailing block comments
    match = line.match(/^\s*[^\/\*\s]+(\/\*.+)\*\//);
    if (match) {
      return;
    }

    // Match define
    match = line.match(/^\s*#define\s+(\w+)\s+/);
    if (match) {
      readDefine(this, match, line);
      return;
    }

    match = line.match(/^\s*#define\s+(\w+)\s*\(([^\)]*)\)/);
    if (match) {
      readMacro(this, match, line);
      return;
    }

    // Match global include
    match = line.match(/^\s*#include\s+<([A-Za-z0-9\-_\/.]+)>/);
    if (match) {
      readInclude(this, match);
      return;
    }

    // Match #pragma deprecated
    match = line.match(/#pragma\s+deprecated\s+(.+?(?=(?:\/\*|\/\/|$)))/);
    if (match) {
      this.deprecated = match[1];
      return;
    }

    // Match relative include
    match = line.match(/^\s*#include\s+"([A-Za-z0-9\-_\/.]+)"/);
    if (match) {
      readInclude(this, match);
      return;
    }

    // Match enum structs
    match = line.match(/^\s*(?:enum\s+struct\s+)(\w*)\s*[^\{]*/);
    if (match) {
      readEnum(this, match, line, true);
      return;
    }
    // Match enums
    match = line.match(/^\s*enum(?:\s+(\w+))?\s*[^\{]*/);
    if (match && !/;\s*$/.test(line)) {
      readEnum(this, match, line, false);
      return;
    }

    // Match for loop iteration variable only in the current file
    match = line.match(/^\s*(?:for\s*\(\s*int\s+)([A-Za-z0-9_]*)/);
    if (match) {
      readLoopVariable(this, match, line);
      return;
    }

    match = line.match(/^\s*typedef\s+(\w+)\s*\=\s*function\s+(\w+).*/);
    if (match) {
      readTypeDef(this, match, line);
      return;
    }

    match = line.match(/^\s*typeset\s+(\w+)/);
    if (match) {
      readTypeSet(this, match, line);
      return;
    }

    // Match variables only in the current file
    match = line.match(
      /^\s*(?:(?:new|static|const|decl|public|stock)\s+)*\w+(?:\[\])?\s+(\w+\s*(?:\[[A-Za-z0-9 +\-\*_]*\])*\s*(?:=\s*[^;,]+)?(?:,|;))/
    );
    if (match && !this.IsBuiltIn) {
      readVariable(this, match, line);
      return;
    }

    match = line.match(/^\s*\/\*/);
    if (match) {
      consumeComment(this, line, false);
      return;
    }

    match = line.match(/^\s*\/\//);
    if (match) {
      consumeComment(this, line, true);
      return;
    }

    match = line.match(
      /^\s*methodmap\s+([a-zA-Z][a-zA-Z0-9_]*)(?:\s*<\s*([a-zA-Z][a-zA-Z0-9_]*))?/
    );
    if (match) {
      readMethodMap(this, match, line);
      return;
    }

    // Match properties
    match = line.match(/^\s*property\s+([a-zA-Z]\w*)\s+([a-zA-Z]\w*)/);
    if (match) {
      if (this.state.includes(State.Methodmap)) {
        this.state.push(State.Property);
      }
      try {
        readProperty(this, match, line);
      } catch (e) {
        console.error(e);
        if (this.debugging) {
          console.error(`At line ${this.lineNb} of ${this.filePath}`);
        }
      }
      return;
    }

    match = line.match(
      /^\s*(\bwhile\b|\belse\b|\bif\b|\bswitch\b|\bcase\b|\bdo\b)/
    );
    if (match) {
      // Check if we are still in the conditionnal of the control statement
      // for example, an if statement's conditionnal can span over several lines
      // and call functions
      let parenthesisNB = parentCounter(line);
      let lineCounter = 0;
      let iter = 0;
      while (parenthesisNB !== 0 && iter < 100) {
        iter++;
        line = this.lines[lineCounter];
        lineCounter++;
        parenthesisNB += parentCounter(line);
      }
      // Now we test if the statement uses brackets, as short code blocks are usually
      // implemented without them.
      if (!/\{\s*$/.test(line)) {
        // Test the next line if we didn't match
        if (!/^\s*\{/.test(this.lines[lineCounter])) {
          return;
        }
      }
      this.state.push(State.Loop);
      return;
    }

    match = line.match(
      /^\s*(?:(?:static|native|stock|public|forward)\s+)*(?:[a-zA-Z\-_0-9]:)?([^\s]+)\s*(\w*)\s*\(([^\)]*(?:\)?))(?:\s*)(?:\{?)(?:\s*)(?:[^\;\s]*);?\s*$/
    );
    if (match) {
      readFunction(this, match, line);
    }

    match = line.match(/^\s*}/);
    if (match) {
      manageState(this, line);
      return;
    }

    // Reset the comments buffer
    this.scratch = [];
    this.deprecated = undefined;
    return;
  }

  makeDefinitionRange(name: string, line: string, func = false): Range {
    let re: RegExp = new RegExp(
      func ? `\\b${name}\\b\\s*\\(` : `\\b${name}\\b`
    );
    let start: number = line.search(re);
    let end: number = start + name.length;
    var range = positiveRange(this.lineNb, start, end);
    return range;
  }

  getReferencesMap(): void {
    const MP = [CompletionItemKind.Method, CompletionItemKind.Property];
    const MmEs = [CompletionItemKind.Class, CompletionItemKind.Struct];

    this.items.forEach((item) => {
      if (item.kind === CompletionItemKind.Variable) {
        purgeCalls(item, this.filePath);
        this.referencesMap.set(
          `${item.name}-${item.parent.name}-${
            item.parent.parent ? item.parent.parent.name : globalIdentifier
          }`,
          item
        );
      } else if (
        [CompletionItemKind.Function, CompletionItemKind.Method].includes(
          item.kind
        )
      ) {
        if (item.filePath === this.filePath) {
          this.funcsAndMethodsInFile.push(item as FunctionItem | MethodItem);
        }
        purgeCalls(item, this.filePath);
        this.referencesMap.set(item.name, item);
      } else if (MmEs.includes(item.kind)) {
        if (item.filePath === this.filePath) {
          this.MmEsInFile.push(item as MethodMapItem | EnumStructItem);
        }
        purgeCalls(item, this.filePath);
        this.referencesMap.set(item.name, item);
      } else if (!MP.includes(item.kind) && item.references !== undefined) {
        purgeCalls(item, this.filePath);
        this.referencesMap.set(item.name, item);
      } else if (MP.includes(item.kind) && item.references !== undefined) {
        this.methodsAndProperties.push(item as MethodItem | PropertyItem);
      }
    });

    this.MmEsInFile = this.MmEsInFile.sort(
      (a, b) => a.fullRange.start.line - b.fullRange.start.line
    );

    this.funcsAndMethodsInFile = this.funcsAndMethodsInFile.sort(
      (a, b) => a.fullRange.start.line - b.fullRange.start.line
    );
  }

  getAllMacros(items: SPItem[]): string[] {
    if (items == undefined) {
      return [];
    }
    let arr: string[] = [];
    for (let e of items) {
      if (e.kind === CompletionItemKind.Interface) {
        arr.push(e.name);
      }
    }
    return arr;
  }
}
