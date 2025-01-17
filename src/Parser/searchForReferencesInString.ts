﻿export type referencesSearchCallback = (match: RegExpExecArray) => void;

/**
 * Given a line of text, find references to items and save those references,
 * and ignore words in strings, and comments.
 *
 * The callbackfn handles what to do if a word if found. It handles the search for the corresponding variable.
 * @param  {string} line  The line to analyse.
 * @param  {referencesSearchCallback} callbackfn  The callback function which handles the search.
 * @param  {any} thisArgs The this context that will be passed to the callback function.
 * @returns void
 */
export function searchForReferencesInString(
  line: string,
  callbackfn: referencesSearchCallback,
  thisArgs: any
): void {
  let match: RegExpExecArray;
  const re = /(?:"|'|\/\/|\/\*|\*\/|\w+)/g;
  thisArgs.previousItems = [];
  thisArgs.line = line;
  do {
    match = re.exec(line);
    if (match) {
      if (match[0] === '"' && !thisArgs.parseState.sString) {
        thisArgs.parseState.dString = !thisArgs.parseState.dString;
      } else if (match[0] === "'" && !thisArgs.parseState.dString) {
        thisArgs.parseState.sString = !thisArgs.parseState.sString;
      } else if (
        match[0] === "//" &&
        !thisArgs.parseState.dString &&
        !thisArgs.parseState.sString
      ) {
        break;
      } else if (
        match[0] === "/*" ||
        (match[0] === "*/" &&
          !thisArgs.parseState.dString &&
          !thisArgs.parseState.sString)
      ) {
        thisArgs.parseState.bComment = !thisArgs.parseState.bComment;
      }
      if (
        thisArgs.parseState.bComment ||
        thisArgs.parseState.dString ||
        thisArgs.parseState.sString
      ) {
        continue;
      }
      if (["float", "bool", "char", "int"].includes(match[0])) {
        continue;
      }
      callbackfn.call(thisArgs, match);
    }
  } while (match);
  return;
}
