import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";

let myExtDir : string = vscode.extensions.getExtension ("Sarrus.sourcepawn-vscode").extensionPath;
let TempPath : string = path.join(myExtDir, "tmp/tmpCompiled.smx");

const tempFile = path.join(__dirname, "temp.sp");

export class TimeoutFunction {
  private timeout;

  constructor() {
    this.timeout = undefined;
  }

  public start(callback: (...args: any[]) => void, delay: number) {
    this.timeout = setTimeout(callback, delay);
  }

  public cancel() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }
}

export let throttles: { [key: string]: TimeoutFunction } = {};

export function refreshDiagnostics(
  document: vscode.TextDocument,
  compilerDiagnostics: vscode.DiagnosticCollection
) {
  const spcomp =
    vscode.workspace.getConfiguration("sourcepawnLanguageServer").get<string>(
      "spcomp_path"
    ) || "";
  if (
    !vscode.workspace.getConfiguration("sourcepawnLanguageServer").get(
      "spcomp_path"
    ) ||
    (spcomp !== "" && !fs.existsSync(spcomp))
  ) {
    vscode.window
      .showErrorMessage(
        "SourceMod compiler not found in the project. You need to set the spcomp path for the Linter to work.",
        "Open Settings"
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          vscode.commands.executeCommand("workbench.action.openWorkspaceSettings");
        }
      });
  }

  let throttle = throttles[document.uri.path];
  if (throttle === undefined) {
    throttle = new TimeoutFunction();
    throttles[document.uri.path] = throttle;
  }

  throttle.cancel();
  throttle.start(function () {
    if (path.extname(document.fileName) === ".sp") {
			let scriptingFolder = path.dirname(document.uri.fsPath);
      let diagnostics: vscode.Diagnostic[] = [];
      try {
        let file = fs.openSync(tempFile, "w", 0o765);
        fs.writeSync(file, document.getText());
        fs.closeSync(file);

        execFileSync(spcomp, [
          // Set the path for sm_home
          "-i" +
            vscode.workspace.getConfiguration("sourcepawnLanguageServer").get(
              "sourcemod_home"
            ) || "",
					"-i" + path.join(scriptingFolder, "include"),
          "-v0",
          tempFile,
          "-o"+TempPath,
        ]);
				fs.unlinkSync(TempPath);
	      } catch (error) {
        let regex = /\((\d+)+\) : ((error|fatal error|warning).+)/gm;
        let matches: RegExpExecArray | null;
        while ((matches = regex.exec(error.stdout?.toString() || ""))) {
          const range = new vscode.Range(
            new vscode.Position(Number(matches[1]) - 1, 0),
            new vscode.Position(Number(matches[1]) - 1, 256)
          );
          const severity =
            matches[3] === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Error;
          diagnostics.push(new vscode.Diagnostic(range, matches[2], severity));
        }
      }

      compilerDiagnostics.set(document.uri, diagnostics);
    }
  }, 300);
}

export let compilerDiagnostics = vscode.languages.createDiagnosticCollection(
  "compiler"
);

export let activeEditorChanged = vscode.window.onDidChangeActiveTextEditor(
  (editor) => {
    if (editor) {
      refreshDiagnostics(editor.document, compilerDiagnostics);
    }
  }
);

export let textDocumentOpened = vscode.workspace.onDidOpenTextDocument((event) => {
  refreshDiagnostics(event, compilerDiagnostics);
});

export let textDocumentChanged = vscode.workspace.onDidChangeTextDocument((event) => {
  refreshDiagnostics(event.document, compilerDiagnostics);
});

export let textDocumentClosed = vscode.workspace.onDidCloseTextDocument((document) => {
  compilerDiagnostics.delete(document.uri);
  delete throttles[document.uri.path];
});