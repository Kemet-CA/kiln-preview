// UMD → ESM shim; docx-preview does `import JSZip from "jszip"`
import "./jszip.js";
export default globalThis.JSZip;
