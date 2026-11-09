import React from "react";
import {createRoot} from "react-dom/client";
import {FluidProvider} from "@/lib/fluid-provider";
import {fontWeights} from "@/lib/font-weight";
import App from "./App";
import "@fontsource-variable/inter/standard.css";
import "./index.css";
import "./app.css";
createRoot(document.getElementById("root")).render(<FluidProvider><div style={{"--fw-normal":fontWeights.normal,"--fw-semibold":fontWeights.semibold,"--fw-bold":fontWeights.bold}}><App/></div></FluidProvider>);
