# Descriptors belong to one selected offer, never another handler in the chain.
_caws_service_image_exec() {
  if [[ "$_rh_handler_index" -eq __CAWS_IMAGE_SELECTED_INDEX__ ]]; then
    "$handler_execution_path" "$@"
  else
    "$handler_execution_path" "$@" 3>&- 4<&- 5>&-
  fi
}
