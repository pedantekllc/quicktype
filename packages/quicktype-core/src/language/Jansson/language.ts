/**
 * jansson — a first-class C target that emits jansson-native structs +
 * (de)serialization. It is NOT a fork of the cJSON target: it is written against
 * quicktype's renderer contract and emits only jansson (json_t, json_object_get,
 * json_loads/dumps, json_integer/string/boolean, jansson's own arrays/objects).
 * Zero cJSON / c-list / c-hashtable.
 *
 * Generated, per named type T (header-only, `static` functions):
 *   int     T_from_json(const json_t *root, T *out)  -> 0 on success; absent or
 *           wrong-type fields left unset (has_<f>=false for scalars, NULL for
 *           pointers), so a partial `desired` parses as a partial delta.
 *   json_t *T_to_json(const T *in)  -> new reference (caller json_decref); a key
 *           is emitted only when present.
 *   void    T_free(T *v)  -> frees owned members (recursively).
 */
import type { RenderContext } from "../../Renderer";
import { EnumOption, getOptionValues } from "../../RendererOptions";
import { TargetLanguage } from "../../TargetLanguage";
import type { LanguageName, RendererOptions } from "../../types";

import { JanssonRenderer } from "./JanssonRenderer";

export const janssonOptions = {
    typeIntegerSize: new EnumOption(
        "integer-size",
        "Integer type for JSON integers (json_int_t by default — matches jansson)",
        {
            int32_t: "int32_t",
            int64_t: "int64_t",
            json_int_t: "json_int_t",
        } as const,
        "json_int_t",
        "secondary",
    ),
};

export const janssonLanguageConfig = {
    displayName: "C (jansson)",
    names: ["jansson"],
    extension: "h",
} as const;

export class JanssonTargetLanguage extends TargetLanguage<
    typeof janssonLanguageConfig
> {
    public constructor() {
        super(janssonLanguageConfig);
    }

    public getOptions(): typeof janssonOptions {
        return janssonOptions;
    }

    public get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    public get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected makeRenderer<Lang extends LanguageName = "jansson">(
        renderContext: RenderContext,
        untypedOptionValues: RendererOptions<Lang>,
    ): JanssonRenderer {
        return new JanssonRenderer(
            this,
            renderContext,
            getOptionValues(janssonOptions, untypedOptionValues),
        );
    }
}
