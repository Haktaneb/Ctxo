package org.apache.ibatis.annotations;

/** Test stub with the real MyBatis name; no dependency JAR is needed. */
public @interface Insert {
  String[] value();

  String databaseId() default "";
}
