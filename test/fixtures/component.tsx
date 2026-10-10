import React, { useState } from "react";
import type { User } from "../types/user";
import { formatName,
  formatDate } from "@/utils/format";
import * as api from "./api";
import Button from './Button'
import "./styles.css";
export { helper } from "./helper";
export * from "./reexport";
// import Fake from "./commented-out";
/* import Fake2 from "./block-commented"; */
const url = "https://example.com/import x from 'nope'";
const Lazy = React.lazy(() => import("./LazyPanel"));
const cfg = require("../config.json");

export function Profile({ user }: { user: User }) {
  const [x] = useState(0);
  return <Button onClick={() => api.save(user)}>{formatName(user)} {formatDate(x)}</Button>;
}
