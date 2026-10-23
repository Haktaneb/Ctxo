package jakarta.persistence;

/** Test stub with the real Jakarta Persistence name; no dependency JAR is needed. */
public @interface Column {
  String name() default "";

  boolean nullable() default true;
}
