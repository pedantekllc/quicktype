import { ConvenienceRenderer, type ForbiddenWordsInfo } from "../../ConvenienceRenderer";
import { type Name, type Namer, funPrefixNamer } from "../../Naming";
import type { RenderContext } from "../../Renderer";
import type { OptionValues } from "../../RendererOptions";
import type { Sourcelike } from "../../Source";
import {
    allUpperWordStyle,
    combineWords,
    firstUpperWordStyle,
    legalizeCharacters,
    splitIntoWords,
} from "../../support/Strings";
import type { TargetLanguage } from "../../TargetLanguage";
import { ArrayType, type ClassType, type EnumType, type Type } from "../../Type";
import { matchType } from "../../Type/TypeUtils";

import type { janssonOptions } from "./language";

/* ------------------------------------------------------------------ naming */
const isAscii = (cp: number): boolean => cp < 128;
const isLetterOrUnderscore = (cp: number): boolean =>
    (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
const isNameChar = (cp: number): boolean => isLetterOrUnderscore(cp) || (cp >= 48 && cp <= 57);
const legalizeName = legalizeCharacters((cp) => isAscii(cp) && isNameChar(cp));
const lower = (w: string): string => w.toLowerCase();
const upper = (w: string): string => w.toUpperCase();

const pascal = (s: string): string =>
    combineWords(splitIntoWords(s), legalizeName, firstUpperWordStyle, firstUpperWordStyle, allUpperWordStyle, allUpperWordStyle, "", isLetterOrUnderscore);
const snake = (s: string): string =>
    combineWords(splitIntoWords(s), legalizeName, lower, lower, lower, lower, "_", isLetterOrUnderscore);
const upperUnderscore = (s: string): string =>
    combineWords(splitIntoWords(s), legalizeName, upper, upper, allUpperWordStyle, allUpperWordStyle, "_", isLetterOrUnderscore);

const typeNamer = funPrefixNamer("types", pascal);
const memberNamer = funPrefixNamer("members", snake);
const enumNamer = funPrefixNamer("enums", upperUnderscore);

const FORBIDDEN = [
    // C11 keywords
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double",
    "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long",
    "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct",
    "switch", "typedef", "union", "unsigned", "void", "volatile", "while",
    "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Complex", "_Generic", "_Imaginary",
    "_Noreturn", "_Static_assert", "_Thread_local",
    // C23 keywords (gcc 15 / clang default to C23 and treat these as reserved)
    "alignas", "alignof", "constexpr", "nullptr", "static_assert", "thread_local",
    "typeof_unqual", "_BitInt", "_Decimal32", "_Decimal64", "_Decimal128",
    // GNU / common extensions + <stdbool.h>
    "asm", "typeof", "__asm__", "__typeof__", "__attribute__", "__extension__",
    "__inline__", "__volatile__", "__const__", "__restrict", "__restrict__",
    "true", "false", "bool", "NULL",
    // jansson / libc identifiers we emit
    "size_t", "json_t", "json_int_t", "json_error_t", "FILE",
];

/* The C representation a value collapses to. Arrays are only "array" at the
 * struct-field / top-level level; an array nested as an *element* downgrades to
 * "raw" (json_t*) — see elemCat. */
type Cat = "scalar" | "string" | "class" | "array" | "raw";

export class JanssonRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof janssonOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer { return typeNamer; }
    protected namerForObjectProperty(): Namer { return memberNamer; }
    protected makeUnionMemberNamer(): Namer { return memberNamer; }
    protected makeEnumCaseNamer(): Namer { return enumNamer; }
    protected forbiddenNamesForGlobalNamespace(): string[] { return FORBIDDEN; }
    protected forbiddenForObjectProperties(): ForbiddenWordsInfo {
        return { names: FORBIDDEN, includeGlobalForbidden: false };
    }

    private get intType(): string { return this._options.typeIntegerSize; }

    private emitBlock(line: Sourcelike, f: () => void, closer: Sourcelike = "}"): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine(closer);
    }

    /** Identity. Unions (incl. nullable T|null) are NOT unwrapped — they pass
     * through as raw json_t* so an explicit `null` round-trips (a typed-nullable
     * representation that preserves null/absent/value is a future refinement). */
    private unwrap(t: Type): Type {
        return t;
    }

    /** Category of a value at struct-field / top-level position. */
    private catOf(t0: Type): Cat {
        const t = this.unwrap(t0);
        return matchType<Cat>(
            t,
            () => "raw", () => "raw", () => "scalar", () => "scalar", () => "scalar",
            () => "string", () => "array", () => "class", () => "raw",
            () => "string", () => "raw", () => "string",
        );
    }

    /** Category of a value at array-element position (nested arrays → raw). */
    private elemCat(t: Type): Cat {
        const c = this.catOf(t);
        return c === "array" ? "raw" : c;
    }

    private scalarCType(t: Type): string {
        return matchType<string>(
            this.unwrap(t), () => "json_t *", () => "json_t *", () => "bool",
            () => this.intType, () => "double", () => "char *", () => "json_t *",
            () => "json_t *", () => "json_t *", () => "char *", () => "json_t *", () => "char *",
        );
    }

    /** C type for a value stored as a struct field (non-array) or array element. */
    private cElemType(t0: Type): Sourcelike {
        const t = this.unwrap(t0);
        switch (this.elemCat(t)) {
            case "scalar": return this.scalarCType(t);
            case "string": return "char *";
            case "class":  return [this.nameForNamedType(t), " *"];
            default:       return "json_t *"; // raw (incl. nested array / map / union)
        }
    }

    // ---- parse: json `src` -> C lvalue `dst` (single value, no presence flag) --
    private emitParseValue(t0: Type, dst: Sourcelike, src: Sourcelike, has?: Sourcelike): void {
        const t = this.unwrap(t0);
        const setHas: Sourcelike = has !== undefined ? [" ", has, " = true;"] : [];
        switch (this.elemCat(t)) {
            case "class":
                this.emitLine("if (json_is_object(", src, ")) { ", dst, " = calloc(1, sizeof(*", dst, ")); ", this.nameForNamedType(t), "_from_json(", src, ", ", dst, "); }");
                return;
            case "string":
                this.emitLine("if (json_is_string(", src, ")) { ", dst, " = strdup(json_string_value(", src, ")); }");
                return;
            case "raw":
                this.emitLine("if (", src, ") { ", dst, " = json_incref(", src, "); }");
                return;
            case "scalar":
                matchType<void>(
                    t,
                    () => {}, () => {},
                    () => this.emitLine("if (json_is_boolean(", src, ")) { ", dst, " = json_boolean_value(", src, ");", setHas, " }"),
                    () => this.emitLine("if (json_is_integer(", src, ")) { ", dst, " = (", this.intType, ")json_integer_value(", src, ");", setHas, " }"),
                    () => this.emitLine("if (json_is_number(", src, ")) { ", dst, " = json_number_value(", src, ");", setHas, " }"),
                    () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
                );
                return;
            case "array":
                return; // unreachable: arrays are handled at field/top-level scope
        }
    }

    /** Parse a json array `src` into `(itemsLValue, countLValue)`. */
    private emitParseArray(elem0: Type, itemsLV: Sourcelike, countLV: Sourcelike, src: Sourcelike): void {
        const elem = this.unwrap(elem0);
        this.emitBlock(["if (json_is_array(", src, "))"], () => {
            this.emitLine("size_t n = json_array_size(", src, "), i;");
            this.emitLine(countLV, " = n;");
            this.emitLine(itemsLV, " = n ? calloc(n, sizeof(*", itemsLV, ")) : NULL;");
            this.emitBlock(["for (i = 0; i < n; i++)"], () => {
                this.emitLine("json_t *e = json_array_get(", src, ", i);");
                this.emitParseValue(elem, [itemsLV, "[i]"], "e");
            });
        });
    }

    // ---- serialize: C rvalue -> json_t* (new reference) --------------------
    private valueToJson(t0: Type, expr: Sourcelike): Sourcelike {
        const t = this.unwrap(t0);
        switch (this.elemCat(t)) {
            case "class":  return [this.nameForNamedType(t), "_to_json(", expr, ")"];
            case "string": return ["json_string(", expr, ")"];
            case "raw":    return ["json_incref(", expr, ")"];
            case "scalar":
                return matchType<Sourcelike>(
                    t, () => ["json_incref(", expr, ")"], () => "json_null()",
                    () => ["json_boolean(", expr, ")"], () => ["json_integer(", expr, ")"],
                    () => ["json_real(", expr, ")"], () => ["json_string(", expr, ")"],
                    () => ["json_incref(", expr, ")"], () => ["json_incref(", expr, ")"],
                    () => ["json_incref(", expr, ")"], () => ["json_string(", expr, ")"],
                    () => ["json_incref(", expr, ")"], () => ["json_string(", expr, ")"],
                );
            default: return "json_null()";
        }
    }

    /** Build a json array from `(itemsExpr, countExpr)`, assigning to `dstJson`. */
    private emitArrayToJson(elem0: Type, dstJson: Sourcelike, itemsExpr: Sourcelike, countExpr: Sourcelike): void {
        const elem = this.unwrap(elem0);
        this.emitLine(dstJson, " = json_array();");
        this.emitBlock(["for (size_t i = 0; i < ", countExpr, "; i++)"], () => {
            this.emitLine("json_array_append_new(", dstJson, ", ", this.valueToJson(elem, [itemsExpr, "[i]"]), ");");
        });
    }

    // ---- free --------------------------------------------------------------
    private emitFreeValue(t0: Type, expr: Sourcelike): void {
        const t = this.unwrap(t0);
        switch (this.elemCat(t)) {
            case "class":  this.emitLine(this.nameForNamedType(t), "_free(", expr, "); free(", expr, ");"); break;
            case "string": this.emitLine("free(", expr, ");"); break;
            case "raw":    this.emitLine("json_decref(", expr, ");"); break;
            default: break;
        }
    }

    private emitFreeArray(elem0: Type, itemsLV: Sourcelike, countLV: Sourcelike): void {
        const elem = this.unwrap(elem0);
        if (this.elemCat(elem) !== "scalar") {
            this.emitBlock(["if (", itemsLV, ")"], () => {
                this.emitLine("size_t i;");
                this.emitBlock(["for (i = 0; i < ", countLV, "; i++)"], () => {
                    this.emitFreeValue(elem, [itemsLV, "[i]"]);
                });
            });
        }
        this.emitLine("free(", itemsLV, "); ", itemsLV, " = NULL;");
    }

    // ---- a class struct + its serde ---------------------------------------
    private emitClassStruct(c: ClassType, name: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitBlock(["typedef struct ", name, " "], () => {
            this.forEachClassProperty(c, "none", (pname, _json, p) => {
                const t = this.unwrap(p.type);
                if (this.catOf(t) === "array") {
                    const elem = (t as ArrayType).items;
                    this.emitLine(this.cElemType(elem), " *", pname, "; size_t ", pname, "_count; bool has_", pname, ";");
                } else if (this.catOf(t) === "scalar") {
                    this.emitLine(this.scalarCType(t), " ", pname, "; bool has_", pname, ";");
                } else {
                    this.emitLine(this.cElemType(t), " ", pname, ";");
                }
            });
        }, ["} ", name, ";"]);
    }

    private emitClassSerde(c: ClassType, name: Name): void {
        this.emitBlock(["static int ", name, "_from_json(const json_t *root, ", name, " *out)"], () => {
            this.emitLine("if (!out) return -1;");
            this.emitLine("memset(out, 0, sizeof(*out));");
            this.emitLine("if (!json_is_object(root)) return -1;");
            this.emitLine("json_t *v;");
            this.forEachClassProperty(c, "none", (pname, json, p) => {
                const t = this.unwrap(p.type);
                this.emitLine('v = json_object_get((json_t *)root, "', json, '");');
                if (this.catOf(t) === "array") {
                    this.emitBlock(["if (v)"], () => {
                        this.emitLine("out->has_", pname, " = true;");
                        this.emitParseArray((t as ArrayType).items, ["out->", pname], ["out->", pname, "_count"], "v");
                    });
                } else {
                    this.emitParseValue(t, ["out->", pname], "v", ["out->has_", pname]);
                }
            });
            this.emitLine("return 0;");
        });
        this.ensureBlankLine();
        this.emitBlock(["static json_t *", name, "_to_json(const ", name, " *in)"], () => {
            this.emitLine("json_t *root = json_object();");
            this.emitLine("if (!in) return root;");
            this.forEachClassProperty(c, "none", (pname, json, p) => {
                const t = this.unwrap(p.type);
                if (this.catOf(t) === "array") {
                    this.emitBlock(["if (in->has_", pname, ")"], () => {
                        this.emitLine("json_t *arr;");
                        this.emitArrayToJson((t as ArrayType).items, "arr", ["in->", pname], ["in->", pname, "_count"]);
                        this.emitLine('json_object_set_new(root, "', json, '", arr);');
                    });
                } else if (this.catOf(t) === "scalar") {
                    this.emitLine("if (in->has_", pname, ') json_object_set_new(root, "', json, '", ', this.valueToJson(t, ["in->", pname]), ");");
                } else {
                    this.emitLine("if (in->", pname, ') json_object_set_new(root, "', json, '", ', this.valueToJson(t, ["in->", pname]), ");");
                }
            });
            this.emitLine("return root;");
        });
        this.ensureBlankLine();
        this.emitBlock(["static void ", name, "_free(", name, " *v)"], () => {
            this.emitLine("if (!v) return;");
            this.forEachClassProperty(c, "none", (pname, _json, p) => {
                const t = this.unwrap(p.type);
                if (this.catOf(t) === "array") {
                    this.emitFreeArray((t as ArrayType).items, ["v->", pname], ["v->", pname, "_count"]);
                } else if (this.catOf(t) === "class") {
                    this.emitLine("if (v->", pname, ") { ", this.nameForNamedType(t), "_free(v->", pname, "); free(v->", pname, "); v->", pname, " = NULL; }");
                } else if (this.catOf(t) === "string") {
                    this.emitLine("free(v->", pname, "); v->", pname, " = NULL;");
                } else if (this.catOf(t) === "raw") {
                    this.emitLine("json_decref(v->", pname, "); v->", pname, " = NULL;");
                }
            });
        });
    }

    // ---- a non-object top-level (array / scalar / string / raw) wrapper ----
    private topLevelsNonObject(): Array<[Type, Name]> {
        const out: Array<[Type, Name]> = [];
        this.forEachTopLevel("none", (t, name) => {
            const k = this.unwrap(t).kind;
            if (k !== "class" && k !== "object") out.push([t, name]);
        });
        return out;
    }

    private emitTopLevelStruct(t0: Type, name: Name): void {
        const t = this.unwrap(t0);
        this.emitBlock(["typedef struct ", name, " "], () => {
            if (this.catOf(t) === "array") {
                this.emitLine(this.cElemType((t as ArrayType).items), " *value; size_t count;");
            } else if (this.catOf(t) === "scalar") {
                this.emitLine(this.scalarCType(t), " value; bool has_value;");
            } else if (this.catOf(t) === "string") {
                this.emitLine("char *value;");
            } else {
                this.emitLine("json_t *value;");
            }
        }, ["} ", name, ";"]);
    }

    private emitTopLevelSerde(t0: Type, name: Name): void {
        const t = this.unwrap(t0);
        const cat = this.catOf(t);
        this.emitBlock(["static int ", name, "_from_json(const json_t *root, ", name, " *out)"], () => {
            this.emitLine("if (!out) return -1;");
            this.emitLine("memset(out, 0, sizeof(*out));");
            if (cat === "array") {
                this.emitParseArray((t as ArrayType).items, "out->value", "out->count", "(json_t *)root");
            } else {
                this.emitParseValue(t, "out->value", "(json_t *)root", cat === "scalar" ? "out->has_value" : undefined);
            }
            this.emitLine("return 0;");
        });
        this.ensureBlankLine();
        this.emitBlock(["static json_t *", name, "_to_json(const ", name, " *in)"], () => {
            this.emitLine("if (!in) return json_null();");
            if (cat === "array") {
                this.emitLine("json_t *arr;");
                this.emitArrayToJson((t as ArrayType).items, "arr", "in->value", "in->count");
                this.emitLine("return arr;");
            } else if (cat === "string" || cat === "raw") {
                this.emitLine("return in->value ? ", this.valueToJson(t, "in->value"), " : json_null();");
            } else {
                this.emitLine("return in->has_value ? ", this.valueToJson(t, "in->value"), " : json_null();");
            }
        });
        this.ensureBlankLine();
        this.emitBlock(["static void ", name, "_free(", name, " *v)"], () => {
            this.emitLine("if (!v) return;");
            if (cat === "array") {
                this.emitFreeArray((t as ArrayType).items, "v->value", "v->count");
            } else {
                this.emitFreeValue(t, "v->value");
            }
        });
    }

    protected emitSourceStructure(): void {
        this.emitLine("/* GENERATED by quicktype (jansson target) — DO NOT EDIT. */");
        this.emitLine("#pragma once");
        this.ensureBlankLine();
        for (const inc of ["<jansson.h>", "<stdbool.h>", "<stdlib.h>", "<string.h>"]) {
            this.emitLine("#include ", inc);
        }
        this.ensureBlankLine();

        const tops = this.topLevelsNonObject();

        // forward typedefs + prototypes (order-independent / recursive).
        this.forEachObject("none", (_c: ClassType, n: Name) => this.emitLine("typedef struct ", n, " ", n, ";"));
        for (const [, n] of tops) this.emitLine("typedef struct ", n, " ", n, ";");
        this.ensureBlankLine();
        const proto = (n: Name): void => {
            this.emitLine("static int ", n, "_from_json(const json_t *root, ", n, " *out);");
            this.emitLine("static json_t *", n, "_to_json(const ", n, " *in);");
            this.emitLine("static void ", n, "_free(", n, " *v);");
        };
        this.forEachObject("none", (_c: ClassType, n: Name) => proto(n));
        for (const [, n] of tops) proto(n);
        this.ensureBlankLine();

        // struct definitions.
        this.forEachObject("leading-and-interposing", (c: ClassType, n: Name) => this.emitClassStruct(c, n));
        for (const [t, n] of tops) { this.ensureBlankLine(); this.emitTopLevelStruct(t, n); }
        this.ensureBlankLine();

        // serde definitions.
        this.forEachObject("leading-and-interposing", (c: ClassType, n: Name) => this.emitClassSerde(c, n));
        for (const [t, n] of tops) { this.ensureBlankLine(); this.emitTopLevelSerde(t, n); }
    }

    // enums ride as strings; nullable unions unwrap; other unions/maps are raw.
    protected emitEnum(_e: EnumType, _name: Name): void {}
}
